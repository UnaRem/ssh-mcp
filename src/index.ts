/**
 * MCP stdio server 入口：注册对外的两个工具，运行连接池与会话登记。
 *
 * 分工（docs/domain.md 里写着同一条线）：
 * - src/tools/* 定义对外契约（schema + handler），只通过 BridgeCtx 访问内部；
 * - 本文件只做进程内的装配：配置与超时、连接池、会话登记、错误映射、检索关键词注入、参数严格校验；
 * - 内部上下文（config/backend/session/exec/sftlops/result）不直接对外。
 * 进程生命周期 = MCP server 生命周期；退出时关掉连接与会话，不留任何后台进程。
 */
import fs from "node:fs";
import os from "node:os";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { connectTo, type ConnHandle } from "./backend.ts";
import type { Acquired, BridgeCtx, ToolDef } from "./bridge.ts";
import { ensureLocalConfigTemplate, listHosts, resolveTarget, type TargetInput } from "./config.ts";
import { fromError } from "./envelope.ts";
import { KnownHostsStore } from "./knownhosts.ts";
import { SessionManager } from "./session.ts";
import * as sftlops from "./sftlops.ts";
import type { ResolvedTarget } from "./types.ts";
import { DEFAULT_EXEC_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS, DEFAULT_SESSION_TTL_MS, ok, VERSION } from "./tool.ts";
import { fileTool } from "./tools/file.ts";
import { runTool } from "./tools/run.ts";

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

// 首启没有任何配置 → 在活动路径生成模板（只创建不覆盖；写不了也只是告警，不阻塞启动）。
const createdTemplate = ensureLocalConfigTemplate();
if (createdTemplate) {
  console.error(`[ssh-mcp] 未找到本地 profile，已在 ${createdTemplate} 生成配置模板：填好 hosts 即生效。`);
}

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

/** 自省：不传参数就能拿到主机清单、配置来源与活动状态。这是把 ssh_hosts 省掉的那次调用。 */
function inventory(): Record<string, unknown> {
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
    hint: "host 传上面任意一个 name；也可以直接写 user@ip。",
  };
}

const ctx: BridgeCtx = {
  execTimeoutMs: settings.execTimeoutMs,
  sessionTtlMs: settings.sessionTtlMs,
  acquire,
  connMeta,
  hostKeyOf: poolKey,
  openSftp: (conn) => sftlops.openSftp(conn.conn),
  sessions,
  inventory,
};

// ---------- 工具注册 ----------
export function buildServer(): McpServer {
  const mcp = new McpServer(
    // name 会规范化成 PI-Desktop 工具前缀 `mcp_<name>_`（实测 2026-10-26：mcp.json 的 server 键不参与
    // 命名，只有这里的 name 决定前缀）。原 "ssh-mcp" 让工具名出现 ssh_..._ssh_ 交错重复段，
    // 模型漏写段（mcp_ssh_mcp_batch）即回落文本；改 "ssh" 后为 mcp_ssh_ssh_run。
    { name: "ssh", version: VERSION },
    {
      instructions:
        "这是一层 SSH 桥：远端 Linux 上跑命令只用 ssh_run，本机与远端之间搬文件只用 ssh_file。" +
        "命令按原生 shell 写（多步用 && / ; / 管道，取尾部用 tail -n，区间用 sed -n，写文件用 heredoc，建目录用 mkdir -p）。" +
        "命令的 exit_code != 0 是数据，不是工具错误。不知道有哪些主机时，ssh_run 不传任何参数就返回清单。" +
        "要跨调用保持 cwd 与 export，就在 ssh_run 里加 session=\"keep\"。",
    },
  );

  for (const def of [runTool, fileTool]) register(mcp, ctx, def);
  return mcp;
}

/**
 * 注册中间件只做三件事：拼检索关键词、把参数集合作为硬契约（多余参数不静默丢弃）、
 * 把异常翻译成带 error_code 的结构化错误。
 * 参数严格化用 zod 的 strict：发布的 JSON Schema 会带 additionalProperties:false，
 * 模型能自己看见「只能传这些」，写错时也立刻被拒，而不是被静默丢掉后以为传对了。
 */
function register(mcp: McpServer, bridge: BridgeCtx, def: ToolDef): void {
  const raw = (mcp.registerTool as unknown as (name: string, config: Record<string, unknown>, handler: unknown) => void).bind(mcp);
  raw(
    def.name,
    { title: def.title, description: `${def.description} ${def.keywords}`, inputSchema: z.object(def.shape).strict() },
    async (argsIn: unknown) => {
      const args = (argsIn ?? {}) as Record<string, unknown>;
      try {
        return ok(await def.handler(bridge, args));
      } catch (e) {
        // 不在这里动连接池：参数/会话类错误与连接无关，误摘会把同一主机上的会话一起杀掉（实测：
        // 一次 op 写错的 ssh_file 调用让 keep 会话消失了）。连接真的断了，ssh2 的 close/error 事件
        // 会把池项摘掉；空闲过 TTL 的连接在下次取用时判定丢弃。
        return fromError(e, def.name);
      }
    },
  );
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
    process.stderr.write(`启动失败：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
    closeAll();
    process.exit(1);
  });
}

export { closeAll, sessions, pool };
