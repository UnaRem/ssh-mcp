/**
 * SFTP 原子操作。大小上限是硬约束：超了直接拒绝并说明上限，避免把远端大文件灌进上下文。
 * 路径：~ / ~/x 先经 realpath 换成远端家目录（家目录按连接缓存），其余路径原样交给服务端。
 */
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Client, SFTPWrapper, Stats, FileEntryWithStats } from "ssh2";
import type { DirEntry, StatInfo } from "./types.ts";

export const MAX_TEXT_BYTES = 512 * 1024;
export const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;

/** 只依赖 sftp()：真实 Client 与测试替身都满足这个形状 */
export type SshClientLike = Pick<Client, "sftp">;

export function openSftp(conn: SshClientLike): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp!)));
  });
}

/** OpenSSH 的 sftp-server 起始目录就是登录用户的家目录，realpath(".") 即家目录 */
const homeCache = new WeakMap<SFTPWrapper, string>();

export function remoteHomeDir(s: SFTPWrapper): Promise<string> {
  const cached = homeCache.get(s);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    s.realpath(".", (err, abs) => {
      const home = !err && abs ? abs : "";
      if (home) homeCache.set(s, home);
      resolve(home);
    });
  });
}

/** 把 ~ 与 ~/x 换成远端家目录；解析不到就原样返回（服务端可能自己展开） */
export async function resolveRemotePath(s: SFTPWrapper, p: string): Promise<string> {
  if (p !== "~" && !p.startsWith("~/")) return p;
  const home = await remoteHomeDir(s);
  if (!home) return p;
  return p === "~" ? home : home.replace(/\/$/, "") + p.slice(1);
}

type FType = "file" | "dir" | "link" | "other";

function typeOf(s: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): FType {
  if (s.isSymbolicLink()) return "link";
  if (s.isDirectory()) return "dir";
  if (s.isFile()) return "file";
  return "other";
}

function fromStats(p: string, s: Stats): StatInfo {
  return {
    path: p,
    type: typeOf(s),
    size: s.size,
    mode: (s.mode & 0o7777).toString(8),
    mtime: s.mtime,
    uid: s.uid,
    gid: s.gid,
  };
}

export interface ListResult {
  path: string;
  count: number;
  entries: DirEntry[];
  hidden_excluded: boolean;
}

export async function sftpList(s: SFTPWrapper, remotePath: string, includeHidden = false): Promise<ListResult> {
  const dir = await resolveRemotePath(s, remotePath);
  return new Promise((resolve, reject) => {
    s.readdir(dir, (err, entries) => {
      if (err) return reject(Object.assign(err, { path: dir }));
      const items: DirEntry[] = entries
        .filter((e) => includeHidden || (e.filename !== "." && e.filename !== ".." && !e.filename.startsWith(".")))
        .map((e) => {
          const attr = (e as FileEntryWithStats).attrs;
          return {
            name: e.filename,
            type: attr ? typeOf(attr) : "other",
            size: attr?.size ?? 0,
            mode: attr ? (attr.mode & 0o7777).toString(8) : "",
            mtime: attr?.mtime ?? 0,
          };
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      resolve({ path: dir, count: items.length, entries: items, hidden_excluded: !includeHidden });
    });
  });
}

export async function sftpStat(s: SFTPWrapper, remotePath: string): Promise<StatInfo> {
  const p = await resolveRemotePath(s, remotePath);
  return new Promise((resolve, reject) => {
    s.stat(p, (err, st) => (err ? reject(Object.assign(err, { path: p })) : resolve(fromStats(p, st))));
  });
}

/** 不存在时返回 null 而不是抛错：供覆盖检查与错误提示使用 */
export function sftpTryStat(s: SFTPWrapper, remotePath: string): Promise<StatInfo | null> {
  return sftpStat(s, remotePath).catch(() => null);
}

export interface ReadResult {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
  total_bytes: number;
  size_known: boolean;
  lines: number;
  looks_binary: boolean;
}

export async function sftpRead(s: SFTPWrapper, remotePath: string, maxBytes = MAX_TEXT_BYTES): Promise<ReadResult> {
  const p = await resolveRemotePath(s, remotePath);
  const cap = Math.max(1, Math.min(maxBytes, MAX_TRANSFER_BYTES));
  return new Promise((resolve, reject) => {
    s.open(p, "r", (err, fh) => {
      if (err) return reject(Object.assign(err, { path: p }));
      // 先 fstat 拿到真实大小：截断时 total_bytes 才是准的，不必把整个文件读一遍
      s.fstat(fh, (_statErr, st) => {
        const declared = st && typeof st.size === "number" ? st.size : undefined;
        const want = cap + 1; // 多读 1 字节即可判断是否被截断
        const chunks: Buffer[] = [];
        let total = 0;
        const closeAndReject = (e: Error) => s.close(fh, () => reject(Object.assign(e, { path: p })));
        const finish = () => {
          s.close(fh, () => {
            const data = Buffer.concat(chunks).subarray(0, cap);
            const text = data.toString("utf8");
            const totalBytes = declared !== undefined && declared >= total ? declared : total;
            resolve({
              path: p,
              size: totalBytes,
              content: text,
              truncated: totalBytes > data.length,
              total_bytes: totalBytes,
              size_known: declared !== undefined,
              lines: text.length === 0 ? 0 : text.split("\n").length,
              looks_binary: data.includes(0),
            });
          });
        };
        const step = (pos: number) => {
          if (pos >= want) return finish();
          const buf = Buffer.alloc(Math.min(64 * 1024, want - pos));
          s.read(fh, buf, 0, buf.length, pos, (readErr, len) => {
            if (readErr) return closeAndReject(readErr);
            if (!len) return finish();
            total += len;
            if (pos < cap) chunks.push(buf.subarray(0, Math.min(len, cap - pos)));
            step(pos + len);
          });
        };
        step(0);
      });
    });
  });
}

export interface WriteResult {
  path: string;
  written: number;
  mode: string | undefined;
  append: boolean;
  stat: StatInfo | null;
}

export async function sftpWrite(s: SFTPWrapper, remotePath: string, content: string, mode?: number, append = false): Promise<WriteResult> {
  const p = await resolveRemotePath(s, remotePath);
  const buf = Buffer.from(content, "utf8");
  if (buf.length > MAX_TEXT_BYTES) {
    throw new Error(`内容 ${buf.length} 字节，超过 sftp_write 上限 ${MAX_TEXT_BYTES} 字节；请改用 sftp_put`);
  }
  return new Promise((resolve, reject) => {
    const done = (chmodErr?: Error | null) => {
      if (chmodErr) return reject(Object.assign(chmodErr, { path: p, note: "内容已写入，但 chmod 失败" }));
      s.stat(p, (statErr, st) => {
        if (statErr) return reject(Object.assign(statErr, { path: p }));
        resolve({ path: p, written: buf.length, mode: mode?.toString(8), append, stat: fromStats(p, st) });
      });
    };
    // 追加走 appendFile，覆盖走 writeFile；权限单独 chmod，避免各服务端对 open flags 的差异
    const step2 = (err?: Error | null) => {
      if (err) return reject(Object.assign(err, { path: p }));
      if (mode === undefined) return done();
      s.chmod(p, mode, done);
    };
    if (append) s.appendFile(p, buf, step2);
    else s.writeFile(p, buf, { flag: "w" }, step2);
  });
}

export interface MkdirResult {
  path: string;
  created: string[];
  already_existing: string[];
}

/** 逐级创建：已存在的层级跳过，不借助 shell。 */
export async function sftpMkdir(s: SFTPWrapper, remotePath: string, recursive = true): Promise<MkdirResult> {
  let dir = await resolveRemotePath(s, remotePath);
  while (dir.length > 1 && dir.endsWith("/")) dir = dir.slice(0, -1);
  if (!dir) dir = "/";
  if (dir === "/") return { path: dir, created: [], already_existing: [] };
  const parts = dir.split("/").filter(Boolean);
  // 递归模式逐级构造绝对路径；非递归只操作最后一级，避免拼出双斜杠
  const targets = recursive ? parts.map((_p, i) => "/" + parts.slice(0, i + 1).join("/")) : [dir];
  const created: string[] = [];
  const existing: string[] = [];
  const step = (i: number): Promise<MkdirResult> => {
    if (i >= targets.length) return Promise.resolve({ path: dir, created, already_existing: existing });
    const target = targets[i]!;
    return new Promise((resolve, reject) => {
      s.mkdir(target, { mode: 0o755 }, (err) => {
        if (!err) {
          created.push(target);
          return resolve(step(i + 1));
        }
        // OpenSSH 对已存在目录常返回笼统的 "Failure"（SFTP code 4），只能 stat 复核
        s.stat(target, (err2, st) => {
          if (!err2 && st && st.isDirectory()) {
            existing.push(target);
            resolve(step(i + 1));
          } else {
            reject(Object.assign(err, { path: target }));
          }
        });
      });
    });
  };
  return step(0);
}

export interface TransferResult {
  local_path: string;
  remote_path: string;
  local_bytes: number;
  remote_bytes: number;
  bytes_match: boolean;
  limit_bytes: number;
}

function checkLocalFile(localPath: string): number {
  if (!fs.existsSync(localPath)) throw new Error(`本地文件不存在：${localPath}`);
  const st = fs.statSync(localPath);
  if (!st.isFile()) throw new Error(`本地路径不是普通文件：${localPath}`);
  if (st.size > MAX_TRANSFER_BYTES) throw new Error(`本地文件 ${st.size} 字节，超过传输上限 ${MAX_TRANSFER_BYTES} 字节`);
  return st.size;
}

export async function sftpPut(s: SFTPWrapper, localPath: string, remotePath: string, overwrite = false): Promise<TransferResult> {
  const local = path.resolve(localPath);
  const localBytes = checkLocalFile(local);
  const remote = await resolveRemotePath(s, remotePath);
  return new Promise((resolve, reject) => {
    s.stat(remote, (err, st) => {
      if (err) {
        // 不存在才继续；其它错误照实返回
        if (!/no such file|not exist|enoent/i.test(String(err.message))) return reject(Object.assign(err, { path: remote }));
      } else if (!overwrite) {
        return reject(new Error(`远端已存在：${remote}（${st.size} 字节）。确认覆盖请传 overwrite=true`));
      } else if (st.isDirectory()) {
        return reject(new Error(`远端是目录：${remote}`));
      }
      s.fastPut(local, remote, (putErr) => {
        if (putErr) return reject(Object.assign(putErr, { local_path: local, path: remote }));
        s.stat(remote, (statErr, after) => {
          if (statErr) return reject(Object.assign(statErr, { path: remote }));
          resolve({
            local_path: local,
            remote_path: remote,
            local_bytes: localBytes,
            remote_bytes: after.size,
            bytes_match: after.size === localBytes,
            limit_bytes: MAX_TRANSFER_BYTES,
          });
        });
      });
    });
  });
}

export async function sftpGet(s: SFTPWrapper, remotePath: string, localPath: string, overwrite = false): Promise<TransferResult> {
  const local = path.resolve(localPath);
  if (fs.existsSync(local) && !overwrite) {
    throw new Error(`本地已存在：${local}（${fs.statSync(local).size} 字节）。确认覆盖请传 overwrite=true`);
  }
  const remote = await resolveRemotePath(s, remotePath);
  return new Promise((resolve, reject) => {
    s.stat(remote, (err, st) => {
      if (err) return reject(Object.assign(err, { path: remote }));
      if (st.isDirectory()) return reject(new Error(`远端是目录，不能用 sftp_get：${remote}`));
      if (st.size > MAX_TRANSFER_BYTES) return reject(new Error(`远端文件 ${st.size} 字节，超过传输上限 ${MAX_TRANSFER_BYTES} 字节`));
      fs.mkdirSync(path.dirname(local), { recursive: true });
      s.fastGet(remote, local, (getErr) => {
        if (getErr) return reject(Object.assign(getErr, { path: remote, local_path: local }));
        const localBytes = fs.statSync(local).size;
        resolve({
          local_path: local,
          remote_path: remote,
          local_bytes: localBytes,
          remote_bytes: st.size,
          bytes_match: localBytes === st.size,
          limit_bytes: MAX_TRANSFER_BYTES,
        });
      });
    });
  });
}
