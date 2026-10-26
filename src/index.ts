/**
 * MCP stdio server 入口：注册全部工具，把结果转成结构化 JSON。
 * 进程生命周期 = MCP server 生命周期；退出时关掉连接与会话，不留任何后台进程。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { connectTo, type ConnHandle } from "./backend.ts";
import { listHosts, localConfigPath, ResolveError, resolveTarget, sshConfigPath, type TargetInput } from "./config.ts";
import { runBatch, runOnce } from "./exec.ts";
import { KnownHostsStore } from "./knownhosts.ts";
import { clampBytes, DEFAULT_MAX_OUTPUT_BYTES, expandTilde } from "./result.ts";
import { SessionManager, type ShellSession } from "./session.ts";
import * as sftlops from "./sftlops.ts";
import type { ResolvedTarget } from "./types.ts";
import {
  clampTimeout,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_SESSION_TTL_MS,
  err,
  formatCause,
  formatError,
  MAX_COMMAND_CHARS,
  MAX_TIMEOUT_MS,
  ok,
  VERSION,
} from "./tool.ts";

const envInt = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const settings = {
  readyTimeoutMs: envInt("SSH_MCP_READY_TIMEOUT_MS", DEFAULT_READY_TIMEOUT_MS),
  execTimeoutMs: envInt("SSH_MCP_EXEC_TIMEOUT_MS", DEFAULT_EXEC_TIMEOUT_MS),
  sessionTtlMs: envInt("SSH_MCP_SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS),
  connTtlMs: envInt("SSH_MCP_CONN_TTL_MS", 300_000),
  knownHostsPath: process.env.SSH_MCP_KNOWN_HOSTS,
};

const knownHosts = KnownHostsStore.load(settings.knownHostsPath);
const sessions = new SessionManager(settings.sessionTtlMs);

/**
 * 连接池：同一 user@host:port 复用一条 SSH 连接（新连接实测 ~1.8s）。
 * 只在 server 进程内，空闲超时即关；不引入 ControlMaster，也不启动任何额外进程。
 */
interface PoolEntry {
  handle: ConnHandle;
  lastUsed: number;
  created: number;
}
const pool = new Map<string, PoolEntry>();

const poolKey = (t: ResolvedTarget) => `${t.user}@${t.hostname}:${t.port}`;

function dropEntry(key: string): void {
  const e = pool.get(key);
  if (!e) return;
  pool.delete(key);
  // 连接断开前先关掉挂在这台主机上的会话，避免留下死管道
  for (const s of sessions.list()) if (s.host === key) sessions.close(s.session_id);
  try {
    e.handle.close();
  } catch {
    /* 已断开 */
  }
}

const poolSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, e] of pool) if (now - e.lastUsed > settings.connTtlMs) dropEntry(key);
}, 30_000);
poolSweep.unref?.();

interface Acquired {
  target: ResolvedTarget;
  conn: ConnHandle;
  reused: boolean;
}

async function acquire(input: TargetInput): Promise<Acquired> {
  const target = resolveTarget(input);
  const key = poolKey(target);
  const existing = pool.get(key);
  if (existing) {
    // 空闲超过 TTL 的连接先丢弃再重建：TTL 必须在取用时判定，
    // 只靠 30s 一次的清扫会让短 TTL 形同虚设（实测 300ms TTL 下第二次仍复用旧连接）
    if (Date.now() - existing.lastUsed > settings.connTtlMs) {
      dropEntry(key);
    } else {
      existing.lastUsed = Date.now();
      return { target, conn: existing.handle, reused: true };
    }
  }
  const handle = await connectTo(target, {
    readyTimeoutMs: settings.readyTimeoutMs,
    knownHosts,
  });
  const entry: PoolEntry = { handle, lastUsed: Date.now(), created: Date.now() };
  pool.set(key, entry);
  // 连接被远端关掉时要从池里摘掉，下一次调用重新建
  const dead = () => {
    if (pool.get(key) === entry) dropEntry(key);
  };
  handle.conn.on("close", dead);
  handle.conn.on("error", dead);
  return { target, conn: handle, reused: false };
}

function closeAll(): void {
  sessions.stop();
  for (const key of [...pool.keys()]) dropEntry(key);
  clearInterval(poolSweep);
}

/** 连接与 host key 的元信息：TOFU 追加、认证顺序这些必须能在结果里看到 */
function connMeta(a: Acquired) {
  const hk = a.conn.hostKey;
  return {
    host: poolKey(a.target),
    resolved_from: a.target.sources,
    connection: a.reused ? "reused" : "new",
    auth_methods_attempted: a.conn.authMethods,
    ...(a.conn.authSucceededWith ? { auth_succeeded_with: a.conn.authSucceededWith } : {}),
    ...(a.conn.identityOffered ? { identity_offered: a.conn.identityOffered } : {}),
    host_key: {
      status: hk.status,
      fingerprint: hk.fingerprint,
      key_type: hk.keyType,
      ...(hk.appended_line ? { appended_to_known_hosts: hk.appended_line } : {}),
      ...(hk.recorded.length ? { known_hosts_records: hk.recorded } : {}),
    },
    known_hosts_path: knownHosts.filePath,
    session_ttl_ms: settings.sessionTtlMs,
  };
}

/** 统一异常翻译：未知主机 / 连接失败 / 其它，都给出可操作的原因而不是原始堆栈 */
async function guard<T extends Record<string, unknown>>(tool: string, host: string | undefined, fn: () => Promise<T>) {
  try {
    return ok(await fn());
  } catch (e) {
    if (host) dropEntryQuietly(host);
    if (e instanceof ResolveError) {
      return err({
        tool,
        error_type: "unknown_host",
        error: e.message,
        available_hosts: e.available,
        ...(e.hint ? { hint: e.hint } : {}),
        ssh_config_path: sshConfigPath(),
        local_config_path: localConfigPath(),
      });
    }
    const cf = (e as Error & { connectFailure?: { reason: string; hint?: string; attempted_methods?: string[]; host_key_fingerprint?: string } }).connectFailure;
    if (cf) {
      return err({
        tool,
        error_type: "connect_failed",
        error: cf.reason,
        ...(cf.hint ? { hint: cf.hint } : {}),
        attempted_methods: cf.attempted_methods ?? [],
        ...(cf.host_key_fingerprint ? { host_key_fingerprint: cf.host_key_fingerprint } : {}),
        ...formatCause(e),
      });
    }
    const name = e instanceof Error ? e.name : "error";
    return err({ tool, error_type: name, error: formatError(e), ...formatCause(e) });
  }
}

/** 出错的调用不留可疑连接：解析主机后把可能的池项摘掉 */
function dropEntryQuietly(host: string): void {
  try {
    dropEntry(poolKey(resolveTarget({ host })));
  } catch {
    /* 主机解析不了，本来也没有池项 */
  }
}

// ---------- 参数 schema ----------
const hostArg = z.string().min(1).describe("目标主机：~/.ssh/config 的别名、config.local.json 里的名字，或 user@ip / ip / [v6]:port");
const userArg = z.string().optional().describe("覆盖用户名（默认取配置）");
const portArg = z.number().int().min(1).max(65535).optional().describe("覆盖端口");
const policyArg = z.enum(["tofu", "strict", "off"]).optional().describe("host key 策略，默认 tofu");
const commandArg = z.string().min(1).max(MAX_COMMAND_CHARS).describe("要在远端执行的命令（原样送进 shell，不做本地改写）");
const timeoutArg = z.number().int().min(100).max(MAX_TIMEOUT_MS).optional().describe(`命令超时毫秒，默认 ${DEFAULT_EXEC_TIMEOUT_MS}`);
const budgetArg = z.number().int().min(256).max(1_000_000).optional().describe(`stdout/stderr 各自的字节预算，默认 ${DEFAULT_MAX_OUTPUT_BYTES}；超出会 truncated=true 并回报真实总量`);
const keepStdinArg = z.boolean().optional().describe("true=保留 stdin（默认 false，自动补 < /dev/null 以免 cat 之类吞掉结束标记）");
const sidArg = z.string().min(1).describe("session_open 返回的会话 id");

function targetOf(a: { host: string; user?: string; port?: number; host_key_policy?: "tofu" | "strict" | "off" }): TargetInput {
  return { host: a.host, user: a.user, port: a.port, host_key_policy: a.host_key_policy };
}

function runOpts(a: { timeout_ms?: number; max_output_bytes?: number; keep_stdin?: boolean }) {
  return {
    timeoutMs: clampTimeout(a.timeout_ms, settings.execTimeoutMs),
    maxOutputBytes: clampBytes(a.max_output_bytes),
    keepStdin: a.keep_stdin === true,
  };
}

function needSession(id: string): ShellSession {
  const s = sessions.get(id);
  if (s) return s;
  const reaped = sessions.reapInfo(id);
  if (reaped) {
    throw new Error(
      `会话 ${id} 已因空闲 ${reaped.idle_ms}ms 超过 TTL ${reaped.ttl_ms}ms 被自动关闭（时间 ${new Date(reaped.at).toISOString()}）。` +
        "请重新 session_open；若需要更长的保留时间，设置环境变量 SSH_MCP_SESSION_TTL_MS。",
    );
  }
  throw new Error(`未知 session_id "${id}"。当前活动会话：${JSON.stringify(sessions.list())}`);
}

function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function parseMode(m?: string): number | undefined {
  if (!m) return undefined;
  return parseInt(m, 8);
}

// ---------- 工具注册 ----------
export function buildServer(): McpServer {
  const mcp = new McpServer(
    { name: "ssh-mcp", version: VERSION },
    {
      instructions:
        "本 server 通过 SSH 连接远端 Linux 主机（Use it for remote Linux hosts over SSH）。" +
        "先 ssh_hosts 列主机；跑命令用 ssh_exec / ssh_batch；需要保持 cd 与环境变量用 session_open + session_exec；" +
        "传文件用 sftp_*（upload = sftp_put，download = sftp_get）。命令退出码非 0 是数据，不是工具错误。",
    },
  );

  // 工具检索关键词并入 description：PI-Desktop 这类客户端按 name/server/description 做词法检索，
  // 且分词只保留 ASCII（实测中文描述完全不参与匹配，英文意图查询「无匹配」），
  // 只靠中文描述会让模型找不到工具。关键词写成 ASCII，任何客户端都能命中。
  const hints: Record<string, string> = {
    ssh_hosts: "Keywords: ssh list hosts remote servers available aliases inventory",
    ssh_exec: "Keywords: ssh run command execute remotely shell exec exit code stdout stderr disk usage df uname systemctl grep log",
    ssh_batch: "Keywords: ssh run several commands batch multiple steps one connection",
    session_open: "Keywords: ssh open remote terminal persistent shell interactive session keep cwd working directory",
    session_exec: "Keywords: ssh run command in session cd export environment variable shell state preserved",
    session_reset: "Keywords: ssh reset shell restart session back to login directory",
    session_close: "Keywords: ssh close session end remote shell logout",
    sftp_list: "Keywords: sftp list remote directory files folder contents ls",
    sftp_stat: "Keywords: sftp remote file info size permissions mode mtime",
    sftp_read: "Keywords: sftp read remote file cat view log file contents text",
    sftp_write: "Keywords: sftp write create remote file append edit config file",
    sftp_mkdir: "Keywords: sftp create remote directory mkdir make folder",
    sftp_put: "Keywords: sftp upload file send file to remote server transfer up",
    sftp_get: "Keywords: sftp download file fetch from remote server transfer down",
  };
  // 只改 description 文本，工具名与 schema 不动（名称影响 mcp 前缀与既有调用）
  const rawRegister = mcp.registerTool.bind(mcp) as (n: string, c: Record<string, unknown>, h: unknown) => void;
  mcp.registerTool = ((name: string, config: Record<string, unknown>, handler: unknown) => {
    const hint = hints[name];
    const cfg = hint ? { ...config, description: `${String(config.description ?? "")} ${hint}` } : config;
    rawRegister(name, cfg, handler);
  }) as typeof mcp.registerTool;
  mcp.registerTool(
    "ssh_hosts",
    {
      title: "列出可用主机",
      description:
        "列出能连接的主机：来自 ~/.ssh/config 的别名 + 本地 config.local.json 的 profile，并说明当前活动会话。" +
        "不知道 host 时先调它，不要猜 IP。",
      inputSchema: {},
    },
    async () =>
      guard("ssh_hosts", undefined, async () => {
        const hosts = listHosts();
        return {
          hosts: hosts.aliases,
          count: hosts.aliases.length,
          ssh_config_path: hosts.ssh_config_path,
          ssh_config_exists: fs.existsSync(hosts.ssh_config_path),
          local_config_path: hosts.local_config_path,
          local_config_exists: fs.existsSync(hosts.local_config_path),
          known_hosts_path: knownHosts.filePath,
          known_hosts_hosts: knownHosts.knownHostPatterns(),
          active_connections: [...pool.keys()],
          active_sessions: sessions.list(),
          home: os.homedir(),
        };
      }),
  );

  mcp.registerTool(
    "ssh_exec",
    {
      title: "执行单条命令",
      description:
        "在远端执行一条命令并返回 exit_code / stdout / stderr / cwd / 是否超时 / 是否截断。" +
        "命令失败（exit_code != 0）不是工具错误，是数据：请直接读 exit_code 与 stderr。" +
        "需要多条命令或要保持 cwd 请用 ssh_batch / session_exec。",
      inputSchema: {
        host: hostArg,
        command: commandArg,
        user: userArg,
        port: portArg,
        host_key_policy: policyArg,
        timeout_ms: timeoutArg,
        max_output_bytes: budgetArg,
        keep_stdin: keepStdinArg,
      },
    },
    async (args) =>
      guard("ssh_exec", args.host, async () => {
        const a = await acquire(targetOf(args));
        const r = await runOnce(a.target, a.conn.conn, args.command, runOpts(args));
        return { ...r, ...connMeta(a) };
      }),
  );

  mcp.registerTool(
    "ssh_batch",
    {
      title: "一次调用执行多条命令",
      description:
        "在同一条 SSH 连接、同一个远端 shell 里按顺序执行多条命令：只付一次连接成本，且 cd 在批次内有效。" +
        "返回每一步各自的 exit_code / stdout / stderr。默认全部执行完（即使某步失败），" +
        "传 stop_on_error=true 可在首个失败处停止。",
      inputSchema: {
        host: hostArg,
        commands: z.array(z.string().min(1).max(MAX_COMMAND_CHARS)).min(1).max(64).describe("按顺序执行的命令"),
        stop_on_error: z.boolean().optional().describe("true=任一步失败即停止；默认 false"),
        max_steps: z.number().int().min(1).max(64).optional().describe("单次最多执行步数，默认 32"),
        user: userArg,
        port: portArg,
        host_key_policy: policyArg,
        timeout_ms: timeoutArg,
        max_output_bytes: budgetArg,
        keep_stdin: keepStdinArg,
      },
    },
    async (args) =>
      guard("ssh_batch", args.host, async () => {
        const a = await acquire(targetOf(args));
        const r = await runBatch(a.target, a.conn.conn, args.commands, {
          ...runOpts(args),
          stopOnError: args.stop_on_error === true,
          maxSteps: args.max_steps,
        });
        return { ...r, ...connMeta(a) };
      }),
  );

  mcp.registerTool(
    "session_open",
    {
      title: "打开连续终端会话",
      description:
        "在这台主机上开一个持续存在的远端 shell。之后的 session_exec 共享同一个 shell：cd、export、shell 函数都保持。" +
        "每条结果都带哨兵解析出的退出码与 cwd。空闲超过 TTL 会被自动关闭（默认 " +
        `${settings.sessionTtlMs}ms，可用 SSH_MCP_SESSION_TTL_MS 调整）。`,
      inputSchema: {
        host: hostArg,
        session_id: z.string().min(1).max(64).optional().describe("自定义会话 id，便于多次调用引用"),
        cwd: z.string().optional().describe("起始工作目录；默认是登录初始目录"),
        env: z.record(z.string(), z.string()).optional().describe("注入到该 shell 的环境变量"),
        user: userArg,
        port: portArg,
        host_key_policy: policyArg,
        max_output_bytes: budgetArg,
        timeout_ms: timeoutArg,
      },
    },
    async (args) =>
      guard("session_open", args.host, async () => {
        const swept = sessions.sweep();
        const a = await acquire(targetOf(args));
        const s = await sessions.create(a.target, a.conn.conn, {
          ...(args.session_id ? { sessionId: args.session_id } : {}),
          ...(args.cwd ? { cwd: args.cwd } : {}),
          ...(args.env ? { env: args.env } : {}),
          maxOutputBytes: clampBytes(args.max_output_bytes),
          timeoutMs: clampTimeout(args.timeout_ms, settings.execTimeoutMs),
        });
        return {
          session_id: s.id,
          cwd: s.cwd,
          shell: s.shell,
          stateful: s.stateful,
          idle_ttl_ms: sessions.idleTtlMs,
          ...(swept.length ? { swept_before_open: swept } : {}),
          ...connMeta(a),
        };
      }),
  );

  mcp.registerTool(
    "session_exec",
    {
      title: "在会话里执行命令",
      description:
        "在已打开的会话里执行一条命令，返回退出码、stdout/stderr、cwd。cwd 与 export 跨调用保持。" +
        "命令吞 stdin / 引号未闭合 / 后台进程占住 fd 都有确定处理（补 < /dev/null、bash -n 预检、background_suspect 并重开会话）。",
      inputSchema: {
        session_id: sidArg,
        command: commandArg,
        timeout_ms: timeoutArg,
        max_output_bytes: budgetArg,
        keep_stdin: keepStdinArg,
      },
    },
    async (args) =>
      guard("session_exec", undefined, async () => {
        const s = needSession(args.session_id);
        const r = await s.exec(args.command, runOpts(args));
        return { ...r, idle_ttl_ms: sessions.idleTtlMs };
      }),
  );

  mcp.registerTool(
    "session_reset",
    {
      title: "重置会话",
      description: "重开该会话的 shell：cwd 回到登录初始目录，丢掉 export 与函数。连接不变，所以比重开会话快。",
      inputSchema: { session_id: sidArg },
    },
    async (args) =>
      guard("session_reset", undefined, async () => {
        const s = needSession(args.session_id);
        const before = s.cwd;
        await s.restart();
        return { session_id: s.id, cwd_before: before, cwd: s.cwd, shell: s.shell };
      }),
  );

  mcp.registerTool(
    "session_close",
    {
      title: "关闭会话",
      description: "关闭一个会话（不传 session_id 则关闭全部）。会话的 shell 结束，但 SSH 连接仍可复用给其它调用。",
      inputSchema: { session_id: z.string().min(1).optional() },
    },
    async (args) =>
      guard("session_close", undefined, async () => {
        if (args.session_id) {
          const closed = sessions.close(args.session_id);
          return { closed: closed ? [args.session_id] : [], was_present: closed, remaining: sessions.list() };
        }
        const closed = sessions.list().map((s) => s.session_id);
        for (const id of closed) sessions.close(id);
        return { closed, remaining: sessions.list() };
      }),
  );

  mcp.registerTool(
    "sftp_list",
    {
      title: "列目录",
      description: "列出远端目录内容（SFTP，不走 shell）。默认隐藏点文件。",
      inputSchema: {
        host: hostArg,
        path: z.string().min(1).describe("远端目录绝对路径；~ 会展开为远端用户家目录"),
        include_hidden: z.boolean().optional(),
        user: userArg,
        port: portArg,
        host_key_policy: policyArg,
      },
    },
    async (args) =>
      guard("sftp_list", args.host, async () => {
        const a = await acquire(targetOf(args));
        const s = await sftlops.openSftp(a.conn.conn);
        try {
          return { ...(await sftlops.sftpList(s, args.path, args.include_hidden === true)), ...connMeta(a) };
        } finally {
          s.end();
        }
      }),
  );

  mcp.registerTool(
    "sftp_stat",
    {
      title: "取文件属性",
      description: "取远端文件/目录的大小、权限、mtime、类型（SFTP）。",
      inputSchema: {
        host: hostArg,
        path: z.string().min(1),
        user: userArg,
        port: portArg,
        host_key_policy: policyArg,
      },
    },
    async (args) =>
      guard("sftp_stat", args.host, async () => {
        const a = await acquire(targetOf(args));
        const s = await sftlops.openSftp(a.conn.conn);
        try {
          return { ...(await sftlops.sftpStat(s, args.path)), ...connMeta(a) };
        } finally {
          s.end();
        }
      }),
  );

  mcp.registerTool(
    "sftp_read",
    {
      title: "读远端文件",
      description:
        `读远端文本文件（默认最多 ${sftlops.MAX_TEXT_BYTES} 字节）。超过上限会 truncated=true 并回报真实大小；` +
        "更大的文件请用 sftp_get 落到本地。",
      inputSchema: {
        host: hostArg,
        path: z.string().min(1),
        max_bytes: z.number().int().min(1).max(sftlops.MAX_TRANSFER_BYTES).optional(),
        user: userArg,
        port: portArg,
        host_key_policy: policyArg,
      },
    },
    async (args) =>
      guard("sftp_read", args.host, async () => {
        const a = await acquire(targetOf(args));
        const s = await sftlops.openSftp(a.conn.conn);
        try {
          const r = await sftlops.sftpRead(s, args.path, args.max_bytes ?? sftlops.MAX_TEXT_BYTES);
          return { ...r, size_limit_bytes: sftlops.MAX_TRANSFER_BYTES, ...connMeta(a) };
        } finally {
          s.end();
        }
      }),
  );

  mcp.registerTool(
    "sftp_write",
    {
      title: "写远端文件",
      description:
        `写入远端文本文件（最多 ${sftlops.MAX_TEXT_BYTES} 字节，超出请改用 sftp_put）。` +
        "append=true 追加；mode 可设权限（八进制字符串如 0644）。",
      inputSchema: {
        host: hostArg,
        path: z.string().min(1),
        content: z.string(),
        append: z.boolean().optional(),
        mode: z
          .string()
          .regex(/^[0-7]{3,4}$/)
          .optional()
          .describe("八进制权限，例如 0644"),
        user: userArg,
        port: portArg,
        host_key_policy: policyArg,
      },
    },
    async (args) =>
      guard("sftp_write", args.host, async () => {
        const a = await acquire(targetOf(args));
        const s = await sftlops.openSftp(a.conn.conn);
        try {
          const r = await sftlops.sftpWrite(s, args.path, args.content, parseMode(args.mode), args.append === true);
          const after = await sftlops.sftpTryStat(s, args.path);
          return { ...r, after, size_limit_bytes: sftlops.MAX_TEXT_BYTES, ...connMeta(a) };
        } finally {
          s.end();
        }
      }),
  );

  mcp.registerTool(
    "sftp_mkdir",
    {
      title: "创建远端目录",
      description: "创建远端目录（默认逐级创建，已存在的层级跳过）。",
      inputSchema: {
        host: hostArg,
        path: z.string().min(1),
        recursive: z.boolean().optional().describe("默认 true"),
        user: userArg,
        port: portArg,
        host_key_policy: policyArg,
      },
    },
    async (args) =>
      guard("sftp_mkdir", args.host, async () => {
        const a = await acquire(targetOf(args));
        const s = await sftlops.openSftp(a.conn.conn);
        try {
          return { ...(await sftlops.sftpMkdir(s, args.path, args.recursive !== false)), ...connMeta(a) };
        } finally {
          s.end();
        }
      }),
  );

  mcp.registerTool(
    "sftp_put",
    {
      title: "上传文件",
      description:
        `上传本地文件到远端（上限 ${sftlops.MAX_TRANSFER_BYTES} 字节）。默认不覆盖已存在的远端文件，` +
        "确认覆盖传 overwrite=true。返回远端大小与本地 sha256，便于校验。",
      inputSchema: {
        host: hostArg,
        local_path: z.string().min(1).describe("本地文件路径，支持 ~"),
        remote_path: z.string().min(1).describe("远端路径；目录必须已存在"),
        overwrite: z.boolean().optional(),
        user: userArg,
        port: portArg,
        host_key_policy: policyArg,
      },
    },
    async (args) =>
      guard("sftp_put", args.host, async () => {
        const a = await acquire(targetOf(args));
        const s = await sftlops.openSftp(a.conn.conn);
        try {
          const lp = expandTilde(args.local_path);
          const r = await sftlops.sftpPut(s, lp, args.remote_path, args.overwrite ?? false);
          return { ...r, local: lp, sha256_local: sha256File(lp), size_limit_bytes: sftlops.MAX_TRANSFER_BYTES, ...connMeta(a) };
        } finally {
          s.end();
        }
      }),
  );

  mcp.registerTool(
    "sftp_get",
    {
      title: "下载文件",
      description:
        `下载远端文件到本地（上限 ${sftlops.MAX_TRANSFER_BYTES} 字节）。默认不覆盖已存在的本地文件，` +
        "确认覆盖传 overwrite=true。返回本地 sha256，便于与远端 sha256sum 比对。",
      inputSchema: {
        host: hostArg,
        remote_path: z.string().min(1),
        local_path: z.string().min(1).describe("本地保存路径，支持 ~；父目录会自动创建"),
        overwrite: z.boolean().optional(),
        user: userArg,
        port: portArg,
        host_key_policy: policyArg,
      },
    },
    async (args) =>
      guard("sftp_get", args.host, async () => {
        const a = await acquire(targetOf(args));
        const s = await sftlops.openSftp(a.conn.conn);
        try {
          const lp = expandTilde(args.local_path);
          const r = await sftlops.sftpGet(s, args.remote_path, lp, args.overwrite ?? false);
          return { ...r, local: lp, sha256_local: sha256File(lp), size_limit_bytes: sftlops.MAX_TRANSFER_BYTES, ...connMeta(a) };
        } finally {
          s.end();
        }
      }),
  );

  return mcp;
}

export async function main(): Promise<void> {
  const mcp = buildServer();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  process.stderr.write(`ssh-mcp ${VERSION} 已启动（pid ${process.pid}）\n`);

  const shutdown = (sig: string) => {
    process.stderr.write(`收到 ${sig}，清理连接与会话\n`);
    closeAll();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  transport.onclose = () => {
    closeAll();
    process.exit(0);
  };
}

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`启动失败：${formatError(e)}\n`);
    closeAll();
    process.exit(1);
  });
}

export { closeAll, sessions, pool, path };
