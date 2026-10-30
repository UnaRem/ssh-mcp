/**
 * 一次性执行（ssh_run 不带 session 的那条路径）。
 * 复用 session.ts 的哨兵 shell：这样一次性调用与连续会话返回的是同一种可判定结构
 * （退出码、stdout/stderr 分开、是否超时、是否截断、cwd）。
 * 「快」来自单次调用内完成多步：新连接实测约 1.8s，一个 batch 只付一次连接成本。
 */
import type { Client } from "ssh2";

import { newNonce, ShellSession, timeoutNote } from "./session.ts";
import { clampTimeout, DEFAULT_EXEC_TIMEOUT_MS } from "./tool.ts";
import type { BatchResult, BatchStep, ExecResult, ResolvedTarget } from "./types.ts";

export interface RunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** 默认给命令补 < /dev/null，避免 cat / read 之类吞掉哨兵 */
  keepStdin?: boolean;
}

export interface BatchOptions extends RunOptions {
  /** true 时任一步失败即停止；默认 false（全部执行完，逐步报告） */
  stopOnError?: boolean;
  maxSteps?: number;
}

export const DEFAULT_MAX_STEPS = 32;
const ONE_SHOT_PREFIX = "one_";

/**
 * 在一条已有连接上跑单条命令：开一个临时 shell，跑完即关。
 * 命令本身失败不算错误（exit_code 在结果里）；只有打不开 shell 才抛。
 */
export async function runOnce(
  target: ResolvedTarget,
  conn: Client,
  command: string,
  opts: RunOptions = {},
): Promise<ExecResult> {
  const session = await ShellSession.open(`${ONE_SHOT_PREFIX}${newNonce()}`, target, conn, {
    maxOutputBytes: opts.maxOutputBytes,
    timeoutMs: opts.timeoutMs,
  });
  try {
    const r = await session.exec(command, opts);
    // 一次性调用没有可续用的会话，别把临时 id 泄漏给调用方
    delete r.session_id;
    return r;
  } finally {
    session.close();
  }
}

function toStep(index: number, command: string, r: ExecResult): BatchStep {
  return {
    index,
    command,
    exit_code: r.exit_code,
    stdout: r.stdout,
    stderr: r.stderr,
    duration_ms: r.duration_ms,
    timed_out: r.timed_out,
    truncated: r.truncated,
    stdout_bytes: r.stdout_bytes,
    stdout_lines: r.stdout_lines,
    ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
  };
}

/**
 * 一次调用、一条连接、同一个远端 shell 内顺序执行多条命令。
 * 因此 cd 在批次内有效，且只付一次连接成本。
 */
export async function runBatch(
  target: ResolvedTarget,
  conn: Client,
  commands: string[],
  opts: BatchOptions = {},
): Promise<BatchResult> {
  const maxSteps = Math.max(1, opts.maxSteps ?? DEFAULT_MAX_STEPS);
  const list = commands.slice(0, maxSteps);
  const started = Date.now();
  // 把默认超时显式解析出来：hint 里要如实写出这次实际用的时长
  const timeoutMs = clampTimeout(opts.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS);

  const session = await ShellSession.open(`${ONE_SHOT_PREFIX}batch_${newNonce()}`, target, conn, {
    maxOutputBytes: opts.maxOutputBytes,
    timeoutMs,
  });

  const steps: BatchStep[] = [];
  let stopped_at: string | undefined;
  let hint: string | undefined;
  let truncated = false;

  try {
    for (let i = 0; i < list.length; i++) {
      const command = list[i]!;
      const r = await session.exec(command, { timeoutMs, keepStdin: opts.keepStdin });
      const step = toStep(i, command, r);
      if (step.truncated) truncated = true;
      steps.push(step);

      if (r.timed_out) {
        stopped_at = `step_${i}_timeout`;
        // 批次停在超时这一步：调用方需要知道剩下的命令没跑、以及这一步的输出已经在 steps[i].stdout 里
        hint =
          `第 ${i} 步（${command}）等待 ${timeoutMs}ms 未结束，已停止等待；` +
          `它到超时为止产生的输出在该步的 stdout 里，第 ${i + 1} 步起共 ${list.length - i - 1} 步未执行。` +
          timeoutNote(timeoutMs);
        break;
      }
      if (opts.stopOnError === true && r.exit_code !== 0) {
        stopped_at = `stop_on_error_at_step_${i}`;
        break;
      }
    }
  } finally {
    session.close();
  }

  const dropped = commands.length - list.length;
  // 有步骤被丢弃时不能报 ok=true：调用方需要知道剩下的命令并没有执行
  const allSucceeded =
    dropped === 0 && steps.length === list.length && steps.every((s) => s.exit_code === 0 && !s.timed_out);
  return {
    ok: allSucceeded && stopped_at === undefined,
    steps,
    cwd: session.cwd,
    shell: session.shell,
    duration_ms: Date.now() - started,
    connection_reused: true,
    truncated,
    ...(stopped_at !== undefined ? { stopped_at } : {}),
    ...(hint !== undefined ? { hint } : {}),
    ...(dropped > 0 ? { dropped } : {}),
  };
}
