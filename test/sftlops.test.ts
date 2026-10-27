/**
 * SFTP 操作的离线测试：用内存文件系统替代真实 SFTP，覆盖 list/stat/read/write/mkdir/put/get
 * 与大小上限、覆盖保护、~ 展开这些「模型容易踩」的分支。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SFTPWrapper } from "ssh2";
import {
  MAX_TEXT_BYTES,
  MAX_TRANSFER_BYTES,
  openSftp,
  remoteHomeDir,
  resolveRemotePath,
  sftpGet,
  sftpList,
  sftpMkdir,
  sftpPut,
  sftpRead,
  sftpStat,
  sftpTryStat,
  sftpWrite,
} from "../src/sftlops.ts";

const HOME = "/home/unarem";

interface FakeNode {
  type: "file" | "dir";
  data: Buffer;
  mode: number;
  mtime: number;
}

const nodes = new Map<string, FakeNode>();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sshmcp-sftp-"));

function put(name: string, data: string | Buffer, mode = 0o644): void {
  nodes.set(name, { type: "file", data: Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"), mode, mtime: 1700000000 });
}
function mkdirNode(name: string): void {
  nodes.set(name, { type: "dir", data: Buffer.alloc(0), mode: 0o755, mtime: 1700000000 });
}

function fakeStats(n: FakeNode) {
  return {
    isDirectory: () => n.type === "dir",
    isFile: () => n.type === "file",
    isSymbolicLink: () => false,
    size: n.data.length,
    mode: n.type === "dir" ? 0o40000 | n.mode : 0o100000 | n.mode,
    mtime: n.mtime,
    uid: 1000,
    gid: 1000,
  };
}

function fail(message: string): Error {
  return new Error(message);
}

let realpathCalls = 0;

const sftp = {
  readdir(dir: string, cb: (err: Error | null, entries?: unknown[]) => void) {
    const n = nodes.get(dir);
    if (!n) return cb(fail(`No such file: ${dir}`));
    if (n.type !== "dir") return cb(fail(`Not a directory: ${dir}`));
    const entries = [...nodes.keys()]
      .filter((k) => k !== dir && path.dirname(k) === dir)
      .map((k) => ({ filename: path.basename(k), attrs: fakeStats(nodes.get(k)!) }));
    cb(null, entries);
  },
  realpath(p: string, cb: (err: Error | undefined, abs: string) => void) {
    realpathCalls++;
    if (p === ".") return cb(undefined, HOME);
    cb(fail("unsupported"), "");
  },
  stat(p: string, cb: (err: Error | null, st?: unknown) => void) {
    const n = nodes.get(p);
    if (!n) return cb(fail(`No such file: ${p}`));
    cb(null, fakeStats(n));
  },
  open(p: string, _flags: string, cb: (err: Error | null, fh?: Buffer) => void) {
    const n = nodes.get(p);
    if (!n) return cb(fail(`No such file: ${p}`));
    cb(null, Buffer.from(p, "utf8"));
  },
  fstat(fh: Buffer, cb: (err: Error | undefined, st?: unknown) => void) {
    const n = nodes.get(fh.toString("utf8"));
    if (!n) return cb(fail("bad handle"));
    cb(undefined, fakeStats(n));
  },
  read(fh: Buffer, buf: Buffer, off: number, len: number, pos: number, cb: (err: Error | null, n?: number) => void) {
    const n = nodes.get(fh.toString("utf8"));
    if (!n) return cb(fail("bad handle"));
    if (pos >= n.data.length) return cb(null, 0);
    const chunk = n.data.subarray(pos, Math.min(pos + len, n.data.length));
    chunk.copy(buf, off);
    cb(null, chunk.length);
  },
  close(_fh: Buffer, cb: () => void) {
    cb();
  },
  writeFile(p: string, data: Buffer, _opts: unknown, cb: (err?: Error | null) => void) {
    const n = nodes.get(p);
    if (n && n.type === "dir") return cb(fail("Is a directory"));
    nodes.set(p, { type: "file", data: Buffer.from(data), mode: n?.mode ?? 0o644, mtime: 1700000001 });
    cb(null);
  },
  appendFile(p: string, data: Buffer, cb: (err?: Error | null) => void) {
    const n = nodes.get(p);
    if (n && n.type === "dir") return cb(fail("Is a directory"));
    nodes.set(p, { type: "file", data: Buffer.concat([n?.data ?? Buffer.alloc(0), data]), mode: n?.mode ?? 0o644, mtime: 1700000002 });
    cb(null);
  },
  chmod(p: string, mode: number, cb: (err?: Error | null) => void) {
    const n = nodes.get(p);
    if (!n) return cb(fail(`No such file: ${p}`));
    n.mode = mode;
    cb(null);
  },
  mkdir(p: string, _opts: unknown, cb: (err?: Error | null) => void) {
    // OpenSSH 对已存在目录返回笼统的 Failure（SFTP code 4），这里照实模拟
    if (nodes.has(p)) return cb(fail("Failure"));
    const parent = path.dirname(p);
    if (parent !== "/" && !nodes.get(parent)) return cb(fail("No such file"));
    mkdirNode(p);
    cb(null);
  },
  fastPut(local: string, remote: string, cb: (err?: Error) => void) {
    try {
      nodes.set(remote, { type: "file", data: fs.readFileSync(local), mode: 0o644, mtime: 1700000003 });
      cb();
    } catch (e) {
      cb(e as Error);
    }
  },
  fastGet(remote: string, local: string, cb: (err?: Error) => void) {
    const n = nodes.get(remote);
    if (!n) return cb(fail(`No such file: ${remote}`));
    fs.writeFileSync(local, n.data);
    cb();
  },
} as unknown as SFTPWrapper;

beforeAll(() => {
  nodes.clear();
  mkdirNode("/home");
  mkdirNode(HOME);
  put(`${HOME}/a.txt`, "alpha\n");
  put(`${HOME}/.hidden`, "secret\n");
  mkdirNode(`${HOME}/sub`);
  put(`${HOME}/sub/b.bin`, Buffer.from([0, 1, 2, 3]));
  mkdirNode(`${HOME}/exist`);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("路径与连接", () => {
  test("~ 与 ~/x 经 realpath 展开为远端家目录", async () => {
    expect(await resolveRemotePath(sftp, "~")).toBe(HOME);
    expect(await resolveRemotePath(sftp, "~/a.txt")).toBe(`${HOME}/a.txt`);
    expect(await resolveRemotePath(sftp, "/abs/path")).toBe("/abs/path");
    expect(await resolveRemotePath(sftp, "relative/x")).toBe("relative/x");
    expect(await remoteHomeDir(sftp)).toBe(HOME);
  });

  test("家目录只解析一次（WeakMap 缓存）", async () => {
    const before = realpathCalls;
    await resolveRemotePath(sftp, "~/one");
    await resolveRemotePath(sftp, "~/two");
    expect(realpathCalls).toBe(before);
  });

  test("openSftp 只依赖 conn.sftp()", async () => {
    const conn = { sftp: (cb: any) => cb(null, sftp) };
    expect(await openSftp(conn as any)).toBe(sftp);
    const bad = { sftp: (cb: any) => cb(new Error("sftp 子系统不可用")) };
    await expect(openSftp(bad as any)).rejects.toThrow("sftp 子系统不可用");
  });
});

describe("sftp_list / sftp_stat", () => {
  test("默认排除隐藏文件，目录排在前面", async () => {
    const r = await sftpList(sftp, HOME);
    expect(r.path).toBe(HOME);
    expect(r.hidden_excluded).toBe(true);
    expect(r.entries.map((e) => e.name)).toEqual(["exist", "sub", "a.txt"]);
    expect(r.count).toBe(3);
    expect(r.entries[0]?.type).toBe("dir");
    const file = r.entries.find((e) => e.name === "a.txt")!;
    expect(file.size).toBe(6);
    expect(file.mode).toBe("644");
  });

  test("include_hidden=true 时列出隐藏文件，~ 等价于家目录", async () => {
    const r = await sftpList(sftp, "~", true);
    expect(r.path).toBe(HOME);
    expect(r.entries.map((e) => e.name)).toContain(".hidden");
  });

  test("sftp_stat 返回权限/大小/uid；不存在时带 path", async () => {
    const st = await sftpStat(sftp, "~/a.txt");
    expect(st).toMatchObject({ path: `${HOME}/a.txt`, type: "file", size: 6, mode: "644", uid: 1000 });
    expect((await sftpStat(sftp, `${HOME}/sub`)).type).toBe("dir");
    await expect(sftpStat(sftp, `${HOME}/nope`)).rejects.toThrow(/No such file/);
    expect(await sftpTryStat(sftp, `${HOME}/nope`)).toBeNull();
  });
});

describe("sftp_read / sftp_write", () => {
  test("读取全文并统计行数；二进制含 NUL 时标记 looks_binary", async () => {
    const r = await sftpRead(sftp, `${HOME}/a.txt`);
    expect(r.content).toBe("alpha\n");
    expect(r.truncated).toBe(false);
    expect(r.total_bytes).toBe(6);
    expect(r.size_known).toBe(true);
    expect(r.looks_binary).toBe(false);
    const bin = await sftpRead(sftp, `${HOME}/sub/b.bin`);
    expect(bin.looks_binary).toBe(true);
  });

  test("截断时 truncated=true 且回报文件真实总字节", async () => {
    const r = await sftpRead(sftp, `${HOME}/a.txt`, 3);
    expect(r.content).toBe("alp");
    expect(r.truncated).toBe(true);
    expect(r.total_bytes).toBe(6);
  });

  test("覆盖写、追加写、chmod", async () => {
    const w = await sftpWrite(sftp, `${HOME}/w.txt`, "one\n");
    expect(w.written).toBe(4);
    expect(w.append).toBe(false);
    expect(w.stat?.size).toBe(4);
    const a = await sftpWrite(sftp, `${HOME}/w.txt`, "two\n", undefined, true);
    expect(a.append).toBe(true);
    expect(nodes.get(`${HOME}/w.txt`)!.data.toString()).toBe("one\ntwo\n");
    const m = await sftpWrite(sftp, `${HOME}/x.sh`, "#!/bin/sh\n", 0o755);
    expect(m.mode).toBe("755");
    expect(nodes.get(`${HOME}/x.sh`)!.mode).toBe(0o755);
  });

  test("超过文本写入上限时直接拒绝并说明上限", async () => {
    const big = "x".repeat(MAX_TEXT_BYTES + 1);
    await expect(sftpWrite(sftp, `${HOME}/big.txt`, big)).rejects.toThrow(new RegExp(`超过文本写入上限 ${MAX_TEXT_BYTES} 字节`));
  });
});

describe("sftp_mkdir", () => {
  test("逐级创建，已存在层级归入 already_existing", async () => {
    const r = await sftpMkdir(sftp, `${HOME}/exist/deep/er`);
    expect(r.already_existing).toEqual(["/home", HOME, `${HOME}/exist`]);
    expect(r.created).toEqual([`${HOME}/exist/deep`, `${HOME}/exist/deep/er`]);
    expect(nodes.get(`${HOME}/exist/deep/er`)?.type).toBe("dir");
  });

  test("非递归模式只创建最后一级，父级缺失时报错并带 path", async () => {
    await expect(sftpMkdir(sftp, `${HOME}/missing/deep`, false)).rejects.toThrow(/No such file/);
    const ok = await sftpMkdir(sftp, `${HOME}/direct`, false);
    expect(ok.created).toEqual([`${HOME}/direct`]);
  });

  test("根目录直接返回空操作，尾部斜杠被规范化", async () => {
    expect(await sftpMkdir(sftp, "/")).toEqual({ path: "/", created: [], already_existing: [] });
    const r = await sftpMkdir(sftp, `${HOME}/tail/`);
    expect(r.created).toEqual([`${HOME}/tail`]);
  });
});

describe("sftp_upload / sftp_download", () => {
  const local = path.join(tmpDir, "roundtrip.bin");

  test("put 往返一致并校验字节数", async () => {
    const data = Buffer.from("round-trip 数据\n".repeat(20), "utf8");
    fs.writeFileSync(local, data);
    const r = await sftpPut(sftp, local, `${HOME}/up.bin`);
    expect(r.bytes_match).toBe(true);
    expect(r.local_bytes).toBe(data.length);
    expect(r.remote_bytes).toBe(data.length);
    expect(nodes.get(`${HOME}/up.bin`)!.data.equals(data)).toBe(true);
    const got = await sftpGet(sftp, `${HOME}/up.bin`, path.join(tmpDir, "down.bin"));
    expect(got.bytes_match).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "down.bin")).equals(data)).toBe(true);
  });

  test("远端已存在时拒绝，overwrite=true 才覆盖", async () => {
    fs.writeFileSync(local, "new");
    await expect(sftpPut(sftp, local, `${HOME}/a.txt`)).rejects.toThrow(/远端已存在.*overwrite=true/);
    const r = await sftpPut(sftp, local, `${HOME}/a.txt`, true);
    expect(r.remote_bytes).toBe(3);
  });

  test("本地已存在时 get 拒绝；远端是目录时拒绝", async () => {
    const target = path.join(tmpDir, "exists.bin");
    fs.writeFileSync(target, "old");
    await expect(sftpGet(sftp, `${HOME}/up.bin`, target)).rejects.toThrow(/本地已存在.*overwrite=true/);
    await expect(sftpGet(sftp, `${HOME}/exist`, path.join(tmpDir, "never2.bin"))).rejects.toThrow(/远端是目录/);
  });

  test("超过传输上限时拒绝并说明上限", async () => {
    const huge = MAX_TRANSFER_BYTES + 1;
    const original = (sftp as any).stat as (p: string, cb: any) => void;
    const bigNode: FakeNode = { type: "file", data: Buffer.alloc(0), mode: 0o644, mtime: 0 };
    (sftp as any).stat = (p: string, cb: any) => {
      if (p === `${HOME}/huge.bin`) return cb(null, { ...fakeStats(bigNode), size: huge });
      return original(p, cb);
    };
    await expect(sftpGet(sftp, `${HOME}/huge.bin`, path.join(tmpDir, "never.bin"))).rejects.toThrow(
      new RegExp(`超过传输上限 ${MAX_TRANSFER_BYTES} 字节`),
    );
    (sftp as any).stat = original;
  });

  test("本地文件不存在时 put 报错", async () => {
    await expect(sftpPut(sftp, path.join(tmpDir, "nope.bin"), `${HOME}/nope.bin`)).rejects.toThrow(/本地文件不存在/);
  });
});
