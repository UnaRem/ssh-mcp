// known_hosts 的解析、匹配与「仅追加」写入。
// ssh2 不内置 host key 校验（lib/client.js 无相关逻辑），这里通过 connect 的
// hostVerifier 钩子把服务器主机密钥接到本模块，实现 TOFU 与不匹配拒绝。

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type VerifyStatus = "match" | "mismatch" | "unknown";

export interface VerifyOutcome {
  status: VerifyStatus;
  /** 已记录的该主机其他密钥（不匹配时用于说明冲突） */
  recorded: string[];
  fingerprint: string;
  keyType: string;
}

interface KHEntry {
  /** 明文主机模式；hash 形式为 null */
  patterns: string[];
  negations: string[];
  hashed: { salt: Buffer; hash: string } | null;
  keyType: string;
  blobB64: string;
  /** 该行是否带 @cert-authority 等 marker（本工具不使用，仅保留不误判） */
  marker: string | null;
}

function defaultKnownHostsPath(): string {
  return path.join(os.homedir(), ".ssh", "known_hosts");
}

/** 主机指纹：SHA256:<base64url>，与 OpenSSH 输出一致 */
export function fingerprint(blob: Buffer): string {
  return "SHA256:" + crypto.createHash("sha256").update(blob).digest("base64url");
}

/** 从 wire blob 中取出 key 类型（blob 的第一个字段就是类型字符串） */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return "unknown";
  const len = blob.readUInt32BE(0);
  if (len <= 0 || 4 + len > blob.length) return "unknown";
  return blob.subarray(4, 4 + len).toString("utf8");
}

/** OpenSSH 主机模式转正则：支持 * 与 ?，其余按字面 */
function patternToRegExp(pattern: string): RegExp {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/** 把 known_hosts 里的一个 host token 拆成 {host, port}，IPv6 用方括号形式 */
function splitToken(token: string): { host: string; port: number | null } {
  if (token.startsWith("[")) {
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(token);
    if (m) return { host: m[1]!, port: m[2] ? Number(m[2]) : null };
    return { host: token, port: null };
  }
  const m = /^([^:]+):(\d+)$/.exec(token);
  if (m) return { host: m[1]!, port: Number(m[2]) };
  return { host: token, port: null };
}

/** 连接时可能出现在 known_hosts 里的几种写法 */
export function hostCandidates(hostname: string, port: number): string[] {
  const out = new Set<string>([hostname]);
  if (port !== 22) {
    out.add(hostname);
    out.add(`[${hostname}]:${port}`);
  }
  return [...out];
}

export class KnownHostsStore {
  private entries: KHEntry[] = [];

  constructor(readonly filePath: string = defaultKnownHostsPath()) {}

  static load(filePath?: string): KnownHostsStore {
    const store = new KnownHostsStore(filePath ?? defaultKnownHostsPath());
    store.reload();
    return store;
  }

  reload(): void {
    this.entries = [];
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const parts = trimmed.split(/\s+/);
      let idx = 0;
      let marker: string | null = null;
      if (parts[0] && parts[0].startsWith("@")) {
        marker = parts[0];
        idx = 1;
      }
      const hostList = parts[idx];
      const keyType = parts[idx + 1];
      const blobB64 = parts[idx + 2];
      if (!hostList || !keyType || !blobB64) continue;

      const patterns: string[] = [];
      const negations: string[] = [];
      let hashed: KHEntry["hashed"] = null;
      for (const token of hostList.split(",")) {
        if (token.startsWith("!")) {
          negations.push(token.slice(1));
          continue;
        }
        const hm = /^\|1\|([^|]+)\|([^|]+)$/.exec(token);
        if (hm) hashed = { salt: Buffer.from(hm[1]!, "base64"), hash: hm[2]! };
        else patterns.push(token);
      }
      this.entries.push({ patterns, negations, hashed, keyType, blobB64, marker });
    }
  }

  /** 已出现过的主机写法，用于提示 */
  knownHostPatterns(): string[] {
    const set = new Set<string>();
    for (const e of this.entries) for (const p of e.patterns) set.add(p);
    return [...set].sort();
  }

  private entryMatches(e: KHEntry, hostname: string, port: number): boolean {
    const targets = hostCandidates(hostname, port);
    if (e.hashed) {
      for (const t of targets) {
        const h = crypto.createHmac("sha1", e.hashed.salt).update(t).digest("base64");
        if (h === e.hashed.hash) return true;
      }
    }
    for (const p of e.negations) {
      const { host, port: pport } = splitToken(p);
      if ((pport === null || pport === port) && patternToRegExp(host).test(hostname)) return false;
    }
    for (const p of e.patterns) {
      const { host, port: pport } = splitToken(p);
      if (pport !== null && pport !== port) continue;
      for (const t of targets) {
        const ts = splitToken(t);
        if (patternToRegExp(host).test(ts.host)) return true;
      }
    }
    return false;
  }

  /**
   * 校验服务器主机密钥。
   * @param blob hostVerifier 收到的 hostPubKey，就是 known_hosts 第 3 列的 wire blob
   */
  verify(hostname: string, port: number, blob: Buffer): VerifyOutcome {
    const wantB64 = blob.toString("base64");
    const fp = fingerprint(blob);
    const keyType = keyTypeOf(blob);
    const recorded: string[] = [];
    let matchedType = false;

    for (const e of this.entries) {
      if (!this.entryMatches(e, hostname, port)) continue;
      if (e.blobB64 === wantB64) return { status: "match", recorded: [], fingerprint: fp, keyType };
      matchedType = true;
      recorded.push(`${e.keyType} ${fingerprint(Buffer.from(e.blobB64, "base64"))}`);
    }
    return {
      status: matchedType ? "mismatch" : "unknown",
      recorded,
      fingerprint: fp,
      keyType,
    };
  }

  /** TOFU：首次见到就追加一行，只追加、绝不改写既有内容 */
  append(hostname: string, port: number, blob: Buffer): { line: string; created: boolean } {
    const spec = port === 22 ? hostname : `[${hostname}]:${port}`;
    const keyType = keyTypeOf(blob);
    const line = `${spec} ${keyType} ${blob.toString("base64")}`;

    const dir = path.dirname(this.filePath);
    let created = false;
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch {}
    let needsLeadingNewline = false;
    try {
      const st = fs.statSync(this.filePath);
      if (st.size > 0) {
        const tail = Buffer.alloc(1);
        const fd = fs.openSync(this.filePath, "r");
        try {
          fs.readSync(fd, tail, 0, 1, st.size - 1);
        } finally {
          fs.closeSync(fd);
        }
        needsLeadingNewline = tail[0] !== 0x0a;
      } else {
        created = true;
      }
    } catch {
      created = true;
    }
    fs.appendFileSync(this.filePath, (needsLeadingNewline ? "\n" : "") + line + "\n");
    this.reload();
    return { line, created };
  }
}
