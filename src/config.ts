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

export function localConfigPath(): string {
  return process.env.SSH_MCP_CONFIG ?? path.join(process.cwd(), "config.local.json");
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
  /** 可用于 ssh_hosts 列表的别名（不含通配模式） */
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
       "用 ssh_hosts 查看可用别名，或直接给 IP/域名（如 192.168.1.21）",
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

/** 给 ssh_hosts 用：本地能解析到的全部主机名 */
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
