/**
 * ssh_run：这层桥唯一的执行入口。
 *
 * 契约是「透传一行原生命令」，其余能力都是桥自己保证的：认证与主机校验、连接复用、
 * 退出码与 stdout/stderr 分离、输出预算与总量、跨调用的会话状态。
 * 模型不需要知道我们的哨兵协议、也不需要在多种调用方式之间选。
 */
import { runOnce } from "../exec.ts";
import { bridgeError } from "../envelope.ts";
import type { Acquired, BridgeCtx, ToolDef } from "../bridge.ts";
import { runOptions } from "../bridge.ts";
import { commandArgOpt, cwdArg, envArg, hostArgOpt, budgetArg, sessionArg, sessionOpArg, timeoutArg } from "../schema.ts";
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
function statefulHint(command: string): string | undefined {
  if (!STATEFUL_COMMAND.test(command)) return undefined;
  return (
    "本次是一次性通道：命令里的 cd/export 只在这一次有效。" +
    '要跨调用保持，请在 ssh_run 里加 session="keep"（同一台主机会自动复用同一个 shell）。'
  );
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
    bridgeError(
      "bad_input",
      'session="keep" 需要同时传 host：要知道在哪台主机上保持这个 shell（当前也没有任何活动会话）。',
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

export const runTool: ToolDef = {
  name: "ssh_run",
  title: "在远端执行命令",
  description:
    "在远端 Linux 上执行一行命令，返回 exit_code / stdout / stderr / cwd / 是否超时 / 是否截断与真实总量。" +
    "命令写法就是原生 shell：多步用 && / ; / 管道，取尾部用 tail -n，取区间用 sed -n，过滤用 grep，" +
    "写文件用 cat > f <<'EOF'，建目录用 mkdir -p。命令失败（exit_code != 0）不是工具错误，是数据。" +
    "同一台主机的连接会自动复用；要跨调用保持 cwd 与 export 就传 session=\"keep\"。" +
    "不知道有哪些主机或想看清当前状态时，什么都不传就返回主机清单与活动连接/会话。",
  keywords:
    "Keywords: ssh run command execute remotely shell exec exit code stdout stderr " +
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
          "只想看有哪些主机或当前状态，就什么都不要传。",
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
      const r = await session.exec(a.command!, runOptions(ctx, a));
      return { ...r, session_id: session.id, idle_ttl_ms: ctx.sessions.idleTtlMs };
    }

    if (!a.host) {
      bridgeError(
        "bad_input",
        "缺少 host：传 ~/.ssh/config 里的别名或 user@ip。" +
          "不确定有什么主机就什么都不传，结果会返回主机清单。",
      );
    }
    if (a.cwd || a.env) {
      bridgeError(
        "bad_input",
        'cwd/env 只在建立会话时生效：要保留状态请加 session="keep"；只想这一次就直接在命令里写 cd / export。',
      );
    }

    const acquired = await ctx.acquire({ host: a.host! });
    const r = await runOnce(acquired.target, acquired.conn.conn, a.command!, runOptions(ctx, a));
    const hint = statefulHint(a.command!);
    return {
      ...r,
      ...ctx.connMeta(acquired),
      session: "one_shot",
      ...(hint ? { hint } : {}),
    };
  },
};
