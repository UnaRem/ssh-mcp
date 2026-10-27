// 主机解析：优先复用用户已有的 ~/.ssh/config 与 ~/.ssh/known_hosts，
// 本地 profile（config.local.json，含密码）只补 OpenSSH 配置里没有的凭据。
// 未知别名必须报错并列出可用别名，而不是让模型去猜地址。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SSHConfig from "ssh-config";

import type { HostKeyPolicy, PrivateKeyEntry, ResolvedTarget } from "./types.ts";

export class ResolveError extends Error {
  constructor(
    message: string,
    readonly available: string[],
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ResolveError";
  }
}

/** 本地 profile：只存放 OpenSSH 配置不便表达的凭据（密码、passphrase、策略） */
export interface HostProfile {
  hostname?: string;
  port?: number;
  user?: string;
  password?: string;
  key_passphrase?: string;
  identity_files?: string[];
  host_key_policy?: HostKeyPolicy;
}

export interface LocalConfigFile {
  hosts: Record<string, HostProfile>;
  defaults?: HostProfile;
}

/**
 * 配置文件的发现顺序（未显式给 SSH_MCP_CONFIG 时的兜底）：
 *   1) 可执行文件同级的 config.local.json —— 单文件产物的标准放法（exe 旁放配置，客户端零 env）；
 *      源码直跑时 execPath 是 bun 本身，其目录一般没有该文件，自然落到下一条；
 *   2) 进程 cwd 下的 config.local.json —— 源码直跑场景。
 * 都不存在时返回 cwd 那条路径：不是错误，自省模式据此报 local_config_exists=false。
 */
export function localConfigCandidates(): string[] {
  const explicit = process.env.SSH_MCP_CONFIG;
  if (explicit) return [explicit];
  return [path.join(path.dirname(process.execPath), "config.local.json"), path.join(process.cwd(), "config.local.json")];
}

export function localConfigPath(): string {
  const candidates = localConfigCandidates();
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[candidates.length - 1]!;
}

/**
 * 首次启动、所有候选位置都没有配置时，生成一份格式可见的模板（TOFU/known_hosts 同款：只创建，从不覆盖或改写）。
 * 写入位置 = 第一优先的可写候选（显式 env → exe 同级 → cwd）；写完「活动路径」自然命中它，与发现顺序一致。
 * 占位主机用 RFC5737 的 192.0.2.0/24（TEST-NET，不会与真实主机相撞）；说明放 `_readme`/`_note` 键——
 * loadLocalConfig 只取 hosts/defaults，未知键无害。返回创建的路径；已存在或都写不了返回 null（不阻塞启动）。
 */
export function ensureLocalConfigTemplate(): string | null {
  const targets = localConfigCandidates();
  if (targets.some((p) => fs.existsSync(p))) return null; // 任何一层已有配置 → 不动它
  const template = {
    _readme:
      "填好 hosts 里的条目即生效（每次调用都重新读，不必重启）。" +
      "password 可换成 identity_files；~/.ssh/config 里已有的别名不必写在这里。本键可删。",
    defaults: { host_key_policy: "tofu" },
    hosts: {
      example: {
        _note: "占位示例（192.0.2.0/24 是保留地址段），改成你的机器，或改键名接着用。",
        hostname: "192.0.2.10",
        port: 22,
        user: "ubuntu",
        password: "把密码写在这里",
      },
    },
  };
  for (const p of targets) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(template, null, 2) + "\n");
      return p;
    } catch {
      continue; // 这层不可写（只读目录等）：试下一层
    }
  }
  return null;
}

export function loadLocalConfig(): LocalConfigFile {
  const p = localConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return { hosts: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ResolveError(
      `本地配置 ${p} 不是合法 JSON：${(e as Error).message}`,
      [],
      "修正该文件或设置 SSH_MCP_CONFIG 指向正确文件",
    );
  }
  const cfg = parsed as LocalConfigFile;
  if (!cfg || typeof cfg !== "object" || typeof cfg.hosts !== "object" || cfg.hosts === null) {
    throw new ResolveError(`本地配置 ${p} 缺少 hosts 对象`, []);
  }
  return { hosts: cfg.hosts ?? {}, defaults: cfg.defaults };
}

export function sshConfigPath(): string {
  return process.env.SSH_MCP_SSH_CONFIG ?? path.join(os.homedir(), ".ssh", "config");
}

interface ParsedSshConfig {
  /** 可用于自省清单（不传参数调用 ssh_run）的别名（不含通配模式） */
  aliases: string[];
  /** 计算某别名得到的 OpenSSH 参数 */
  compute: (alias: string) => Record<string, string | string[]>;
  has: (alias: string) => boolean;
}

let cachedSshConfig: { path: string; mtimeMs: number; parsed: ParsedSshConfig } | null = null;

export function readSshConfig(): ParsedSshConfig {
  const p = sshConfigPath();
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(p).mtimeMs;
  } catch {}
  if (cachedSshConfig && cachedSshConfig.path === p && cachedSshConfig.mtimeMs === mtimeMs) {
    return cachedSshConfig.parsed;
  }

  let raw = "";
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    raw = "";
  }
  const cfg = SSHConfig.parse(raw);
  const aliases: string[] = [];
  for (const line of cfg) {
    const rec = line as { param?: string; value?: string };
    if (rec.param !== "Host" || typeof rec.value !== "string") continue;
    for (const name of rec.value.split(/\s+/)) {
      if (name && !name.includes("*") && !name.includes("?") && !name.startsWith("!")) {
        aliases.push(name);
      }
    }
  }
  const aliasSet = new Set(aliases);
  const parsed: ParsedSshConfig = {
    aliases,
    has: (alias: string) => aliasSet.has(alias),
    compute: (alias: string) => cfg.compute(alias) as Record<string, string | string[]>,
  };
  cachedSshConfig = { path: p, mtimeMs, parsed };
  return parsed;
}

function asList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** OpenSSH 的默认私钥候选（仅取存在的那些），避免无意义地尝试一堆 key */
function defaultIdentityCandidates(): string[] {
  const names = ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"];
  const dir = path.join(os.homedir(), ".ssh");
  return names.map((n) => path.join(dir, n)).filter((f) => fs.existsSync(f));
}

/** 判断字符串是不是 IP 字面量（IPv4 / IPv6） */
export function isIpLiteral(s: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.split(".").every((p) => Number(p) <= 255);
  if (!s.includes(":")) return false;
  // 保守的 IPv6 判定：只允许 hex 与 ::，且不含空格
  return /^[0-9a-fA-F:.]+$/.test(s) && s.includes(":");
}

export interface TargetInput {
  host: string;
  /** 覆盖项：显式传参优先于配置 */
  user?: string;
  port?: number;
  password?: string;
  host_key_policy?: HostKeyPolicy;
}

/** 解析 user@host、[v6]:port、host:port、纯别名 */
function splitHostSpec(spec: string): { name: string; user?: string; port?: number } {
  let rest = spec.trim();
  let user: string | undefined;
  const at = rest.indexOf("@");
  if (at > 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let port: number | undefined;
  if (rest.startsWith("[")) {
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
    if (m) {
      rest = m[1]!;
      if (m[2]) port = Number(m[2]);
    }
  } else {
    const m = /^([^:]+):(\d+)$/.exec(rest);
    if (m) {
      rest = m[1]!;
      port = Number(m[2]);
    }
  }
  return { name: rest, user, port };
}

function passwordFromEnv(alias: string): string | undefined {
  const bucket = alias.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return process.env[`SSH_MCP_PASSWORD_${bucket}`] ?? process.env.SSH_MCP_PASSWORD;
}

 /** 报错时要列出两个来源的别名，否则模型看不到本地 profile 里配的主机 */
 export function availableAliases(): string[] {
   const names = new Set<string>([...readSshConfig().aliases, ...Object.keys(loadLocalConfig().hosts)]);
   return [...names].sort();
 }

 /**
  * 解析目标主机。
  * 顺序：本地 profile > ~/.ssh/config 别名 > IP 字面量直连；
  * 都不是则抛 ResolveError 并列出可用别名。
  */
 export function resolveTarget(input: TargetInput): ResolvedTarget {
   const local = loadLocalConfig();
   const ssh = readSshConfig();
   const { name, user: inputUser, port: inputPort } = splitHostSpec(input.host);
   if (!name) throw new ResolveError("host 不能为空", availableAliases());

   const profile = local.hosts[name] ?? null;
   const inSshConfig = ssh.has(name);

   if (!profile && !inSshConfig && !isIpLiteral(name)) {
     throw new ResolveError(
       `未知主机 "${name}"：既不在 ~/.ssh/config 的别名里，也不在本地 config.local.json 里，且不是 IP 字面量。`,
       availableAliases(),
       "用 ssh 别名，或直接给 IP/域名（如 192.168.1.21）；不记得有哪些别名时，不传参数调用 ssh_run 就会返回清单",
     );
   }

  const computed = inSshConfig ? ssh.compute(name) : {};
  const hostname =
    input.host && profile?.hostname
      ? profile.hostname
      : (computed.HostName as string) ?? (inSshConfig ? name : name);

  const port = inputPort ?? input.port ?? profile?.port ?? Number(computed.Port ?? 22);

  const user =
    inputUser ??
    input.user ??
    profile?.user ??
    (computed.User as string) ??
    local.defaults?.user ??
    os.userInfo().username ??
    "root";

  // 密钥优先：IdentityFile 显式配置的在前，其次是标准候选
  const configuredIds = [
    ...asList(computed.IdentityFile as string | string[] | undefined).map(expandHome),
    ...(profile?.identity_files ?? []).map(expandHome),
  ];
  const identityFiles = configuredIds.length > 0 ? configuredIds : defaultIdentityCandidates();

  const privateKeys: PrivateKeyEntry[] = [];
  for (const f of identityFiles) {
    try {
      const data = fs.readFileSync(f);
      if (data.length === 0) continue;
      privateKeys.push({ path: f, data });
    } catch {
      // 不存在的 IdentityFile 静默跳过，但记在 sources 里方便排错
    }
  }

  const password = input.password ?? profile?.password ?? passwordFromEnv(name);
  const keyPassphrase = profile?.key_passphrase;

  const sources: string[] = [];
  if (inSshConfig) sources.push(`ssh_config:${sshConfigPath()}`);
  if (profile) sources.push(`profile:${localConfigPath()}`);
  if (!profile && !inSshConfig) sources.push("direct");
  if (privateKeys.length === 0) sources.push("no-local-key");
  if (password) sources.push("password:local-config");

  return {
    alias: name,
    hostname,
    port,
    user,
    sources,
    identityFiles,
    privateKeys,
    ...(password ? { password } : {}),
    ...(keyPassphrase ? { keyPassphrase } : {}),
    hostKeyPolicy: input.host_key_policy ?? profile?.host_key_policy ?? "tofu",
  };
}

/** 给 ssh_run 的自省模式用：本地能解析到的全部主机名 */
export function listHosts(): {
  ssh_config_path: string;
  local_config_path: string;
  aliases: { name: string; source: string[]; hostname?: string; port?: number; user?: string }[];
} {
  const local = loadLocalConfig();
  const ssh = readSshConfig();
  const out = new Map<string, { name: string; source: string[]; hostname?: string; port?: number; user?: string }>();

  for (const a of ssh.aliases) {
    const c = ssh.compute(a);
    out.set(a, {
      name: a,
      source: ["ssh_config"],
      hostname: (c.HostName as string) ?? a,
      port: c.Port ? Number(c.Port) : undefined,
      user: (c.User as string) ?? undefined,
    });
  }
  for (const [name, p] of Object.entries(local.hosts)) {
    const existing = out.get(name);
    if (existing) {
      existing.source.push("config.local.json");
      if (p.hostname) existing.hostname = p.hostname;
      if (p.port) existing.port = p.port;
      if (p.user) existing.user = p.user;
    } else {
      out.set(name, {
        name,
        source: ["config.local.json"],
        ...(p.hostname ? { hostname: p.hostname } : {}),
        ...(p.port ? { port: p.port } : {}),
        ...(p.user ? { user: p.user } : {}),
      });
    }
  }
  return {
    ssh_config_path: sshConfigPath(),
    local_config_path: localConfigPath(),
    aliases: [...out.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
