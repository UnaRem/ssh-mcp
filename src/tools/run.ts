/**
 * exec：这层桥唯一的执行入口。
 *
 * 契约是「透传一行原生命令」，其余能力都是桥自己保证的：认证与主机校验、连接复用、
 * 退出码与 stdout/stderr 分离、输出预算与总量、跨调用的会话状态。
 * 模型不需要知道我们的哨兵协议、也不需要在多种调用方式之间选。
 * description 只放判定所需的事实；案例/反例/写法教学在 skills/ssh-mcp/SKILL.md
 * （随安装注入），薄厚分界由 test/contract.test.ts 的 MAX_DESCRIPTION_CHARS 守着。
 */
import { runOnce } from "../exec.ts";
import { bridgeError } from "../envelope.ts";
import type { Acquired, BridgeCtx, ToolDef } from "../bridge.ts";
import { runOptions } from "../bridge.ts";
import { commandArgOpt, cwdArg, envArg, hostArgOpt, budgetArg, sessionArg, sessionOpArg, timeoutArg } from "../schema.ts";
import { EXEC_TOOL_NAME, MAX_TIMEOUT_MS } from "../tool.ts";
import type { ShellSession } from "../session.ts";

interface RunArgs {
  host?: string;
  command?: string;
  session?: string;
  session_op?: "reset" | "close";
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  max_output_bytes?: number;
}

/**
 * 命令里有改变 shell 状态的部分时，一次性通道不会带到下一次。
 * 这条提示放在结果里，而不是为此加一个入参。
 */
const STATEFUL_COMMAND = /(^|[;&|]\s*)(cd|export|source|alias|set|unset)\s/;

/** 需要会话才能做到的命令：给出可操作提示，不擅自改成开会话 */
export function statefulHint(command: string): string | undefined {
  if (!STATEFUL_COMMAND.test(command)) return undefined;
  return (
    "本次是一次性通道：命令里的 cd/export 只在这一次有效。" +
    '要跨调用保持，请再调用时带 session="keep"（同一台主机会自动复用同一个 shell）。'
  );
}

/**
 * 用 sleep 占住这次调用 = 白等，而且多半先撞上限。判据与 statefulHint 一样：只提示，不改命令。
 * 阈值 3 秒：3 秒以内的 sleep 通常是链式热身（起服务、等设备就绪），打扰它没有收益
 * （实测 2026-11-05：历史 89 次含 sleep 的调用里，值≤5 的有 30 次，≥20 的有 30 次）。
 */
const SLEEP_ARG = /\bsleep\s+(\d+(?:\.\d+)?)/g;
const SLEEP_HINT_FROM = 3;

export function waitHint(command: string): string | undefined {
  const secs = [...command.matchAll(SLEEP_ARG)].map((m) => Number(m[1]));
  const worst = secs.reduce((a, b) => (b > a ? b : a), 0);
  if (worst < SLEEP_HINT_FROM) return undefined;
  return (
    `命令里有 sleep ${worst}：等待不该占住这次调用（上限 ${MAX_TIMEOUT_MS / 1000} 秒，到点就 timed_out）。` +
    "要跑得更久就起后台再轮询：nohup 长命令 > /path/job.log 2>&1 & echo $!，之后 tail -n 50 /path/job.log 或 kill -0 <pid>。"
  );
}

/** 同一次调用里多条提示合成一条，不新增字段 */
function hintFor(command: string): string | undefined {
  const all = [statefulHint(command), waitHint(command)].filter((h): h is string => Boolean(h));
  return all.length ? all.join(" ") : undefined;
}

/** 解析 session：显式 id 必须存在（含被 TTL 回收的说明）；"keep" 按主机建立或复用 */
async function resolveSession(ctx: BridgeCtx, a: RunArgs): Promise<{ session: ShellSession; acquired?: Acquired }> {
  const id = a.session!;
  if (id !== "keep") {
    const existing = ctx.sessions.get(id);
    if (existing) return { session: existing };
    const reaped = ctx.sessions.reapInfo(id);
    const active = ctx.sessions.list();
    if (reaped) {
      bridgeError(
        "no_session",
        `会话 ${id} 已因空闲 ${reaped.idle_ms}ms 超过 TTL ${reaped.ttl_ms}ms 被自动关闭` +
          `（时间 ${new Date(reaped.at).toISOString()}）。要重新开始就传 session="keep"；` +
          "想更久保留就设环境变量 SSH_MCP_SESSION_TTL_MS。",
        { session_id: id, active_sessions: active },
      );
    }
    bridgeError("no_session", `未知 session "${id}"。当前活动会话：${JSON.stringify(active)}。` + '新建并复用请传 session="keep"。', {
      session_id: id,
      active_sessions: active,
    });
  }
  if (!a.host) {
    // 更聪明的做法：只有一个活动会话时就直接复用它，模型不必每次重复 host
    const active = ctx.sessions.list();
    if (active.length === 1) {
      const only = ctx.sessions.get(active[0]!.session_id);
      if (only) return { session: only };
    }
    if (active.length > 1) {
      bridgeError(
        "bad_input",
        "有多个活动会话，无法只凭 keep 判断用哪一个。请传 host 指明机器，或直接用某个 session_id。",
        { active_sessions: active },
      );
    }
    // 「会话不存在」只有一种错误码：这里虽然缺 host，但真实情形是没有任何可复用的 shell，
    // 报 no_session 才与显式 session id 那条一致（缺 host 的说明写进 error/hint）。
    bridgeError(
      "no_session",
      '当前没有任何活动会话，且没传 host——不知道要在哪台机器上开这个 shell。' +
        '请同时传 host 与 session="keep"（会新建并复用同一个 shell）。',
      { active_sessions: active },
    );
  }
  const acquired = await ctx.acquire({ host: a.host! });
  const key = ctx.hostKeyOf(acquired.target);
  const known = ctx.sessions.list().find((s) => s.host === key);
  if (known) {
    const s = ctx.sessions.get(known.session_id);
    if (s) return { session: s, acquired };
  }
  const created = await ctx.sessions.create(acquired.target, acquired.conn.conn, {
    ...(a.cwd ? { cwd: a.cwd } : {}),
    ...(a.env ? { env: a.env } : {}),
    timeoutMs: runOptions(ctx, a).timeoutMs,
  });
  return { session: created, acquired };
}

export const execTool: ToolDef = {
  name: EXEC_TOOL_NAME,
  title: "在远端执行命令",
  description:
    "在远端 Linux 上执行一行原生命令，返回 exit_code / stdout / stderr / cwd / 是否超时与截断及真实总量。" +
    "exit_code != 0 与 timed_out=true 都是数据，不是工具错误。" +
    `timeout_ms 只能调小（默认即上限 ${MAX_TIMEOUT_MS / 1000} 秒）；跑不完的活用 nohup 起后台再短命令轮询，本桥不等待、也不会杀远端进程。` +
    '跨调用保持 cwd 与 export 传 session="keep"；同一主机的连接自动复用。' +
    `不传任何参数调用 ${EXEC_TOOL_NAME} 会返回主机清单与活动连接/会话。命令写法、正反例与完整语义见 skill「ssh-mcp」。`,
  keywords:
    "Keywords: exec ssh remote linux run command execute remotely shell exec exit code stdout stderr " +
    "list hosts inventory df disk usage uname systemctl journalctl service log grep tail sed cd export pwd " +
    "persistent shell session keep cwd working directory batch multiple steps one connection",
  shape: {
    host: hostArgOpt,
    command: commandArgOpt,
    session: sessionArg,
    session_op: sessionOpArg,
    cwd: cwdArg,
    env: envArg,
    timeout_ms: timeoutArg,
    max_output_bytes: budgetArg,
  },
  handler: async (ctx: BridgeCtx, raw: Record<string, unknown>) => {
    const a = raw as RunArgs;

    // 无参数 = 自省：把「先问有哪些主机」这次调用省掉
    if (!a.host && !a.command && !a.session && !a.session_op) {
      return { mode: "inventory", ...ctx.inventory() };
    }
    if (a.session_op && !a.session) {
      bridgeError("bad_input", "session_op 需要配合 session（值写 keep，或之前结果里返回的 session_id）。");
    }
    if (a.session_op && a.command) {
      bridgeError("bad_input", "session_op 与 command 互斥：只管理会话时不要传 command。");
    }
    if (!a.command && !a.session_op) {
      bridgeError(
        "bad_input",
        "缺少 command：把要在远端跑的这行命令传进来（多步用 && / ; / 管道）。" +
          "只想看有哪些主机或当前状态，就什么都不要传，这次调用会返回清单。",
      );
    }

    if (a.session) {
      const { session, acquired } = await resolveSession(ctx, a);
      if (a.session_op === "reset") {
        const before = session.cwd;
        await session.restart();
        return {
          session_id: session.id,
          cwd_before: before,
          cwd: session.cwd,
          shell: session.shell,
          idle_ttl_ms: ctx.sessions.idleTtlMs,
          ...(acquired ? { ...ctx.connMeta(acquired) } : {}),
        };
      }
      if (a.session_op === "close") {
        ctx.sessions.close(session.id);
        return { closed: [session.id], remaining: ctx.sessions.list() };
      }
      const opts = runOptions(ctx, a);
      const r = await session.exec(a.command!, opts);
      const hint = hintFor(a.command!);
      return { ...r, ...(opts.timeout_meta ?? {}), ...(hint ? { hint } : {}), session_id: session.id, idle_ttl_ms: ctx.sessions.idleTtlMs };
    }

    if (!a.host) {
      bridgeError(
        "bad_input",
        "缺少 host：传 ~/.ssh/config 里的别名或 user@ip。" +
          "不确定有什么主机就什么都不传，这次调用会返回主机清单。",
      );
    }
    if (a.cwd || a.env) {
      bridgeError(
        "bad_input",
        'cwd/env 只在建立会话时生效：要保留状态请加 session="keep"；只想这一次就直接在命令里写 cd / export。',
      );
    }

    const acquired = await ctx.acquire({ host: a.host! });
    const opts = runOptions(ctx, a);
    const r = await runOnce(acquired.target, acquired.conn.conn, a.command!, opts);
    const hint = hintFor(a.command!);
    return {
      ...r,
      ...ctx.connMeta(acquired),
      ...(opts.timeout_meta ?? {}),
      session: "one_shot",
      ...(hint ? { hint } : {}),
    };
  },
};
