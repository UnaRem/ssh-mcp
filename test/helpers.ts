// 离线测试用的远端替身：不联网，用假 channel 模拟一个按哨兵协议对话的 shell。
// 目标是能在本地复现三类坑（吞 stdin、语法不完整、后台挂住 fd）与 cwd 语义。

import { EventEmitter } from "node:events";
import fs from "node:fs";
import { Readable } from "node:stream";
import type { Client, ClientChannel } from "ssh2";

import type { ResolvedTarget } from "../src/types.ts";

export interface FakeCall {
  command: string;
  /** 原始写入内容（含哨兵行），用于断言 < /dev/null 等改写 */
  raw: string;
}

export interface FakeShellState {
  cwd: string;
  calls: FakeCall[];
  /** 已处理的命令数：用来验证 batch 逐条串行执行 */
  commands: number;
  /** client.exec 被调用的次数（含 bash -n 预检） */
  execs: number;
  /** 真正的交互 shell channel 数：验证 batch 只开一个 shell */
  shellChannels: number;
}

export interface FakeShellOptions {
  initialCwd?: string;
  /** 远端没有 bash 时，openShellChannel 应退化为 sh */
  noBash?: boolean;
}

// 哨兵行里写的是字面「反斜杠 + 001」，由远端 printf 解释。用 charCode 拼，避免转义歧义。
const SEP_TEXT = String.fromCharCode(92) + "001";
const SENTINEL_TAG = "MCPEND";

function isSentinelLine(line: string): boolean {
  return line.includes(SENTINEL_TAG);
}

function sentinelNonce(line: string): string {
  const key = SENTINEL_TAG + SEP_TEXT;
  const i = line.indexOf(key);
  if (i < 0) return "";
  const rest = line.slice(i + key.length);
  const j = rest.indexOf(SEP_TEXT);
  return j < 0 ? "" : rest.slice(0, j);
}

/** 假 shell 只处理干净的命令行：先剥掉 guardStdin 追加的 < /dev/null */
function stripStdinGuard(command: string): string {
  const t = command.trim();
  const mark = " < /dev/null";
  return t.endsWith(mark) ? t.slice(0, -mark.length) : t;
}

/** 一个极小的假 shell：实现 cd / pwd / echo / exit，另有剧本关键字 */
function handle(
  state: FakeShellState,
  command: string,
): { stdout: string; stderr: string; exit: number; close?: boolean; hang?: boolean } {
  const cmd = stripStdinGuard(command);
  if (!cmd) return { stdout: "", stderr: "", exit: 0 };

  // 剧本触发器：#hang 不回哨兵（模拟后台进程占住 fd），#die 让 shell 退出。
  // 两者都允许带一段输出（`#hang BEFORE-OUT`），用来验证「超时/通道关闭也要带回已产生的输出」。
  if (cmd.startsWith("#hang")) {
    const rest = cmd.slice("#hang".length).trim();
    return { stdout: rest ? `${rest}\n` : "", stderr: "", exit: 0, hang: true };
  }
  if (cmd.startsWith("#die")) {
    const rest = cmd.slice("#die".length).trim();
    return { stdout: rest ? `${rest}\n` : "", stderr: "", exit: 0, close: true };
  }

  const cd = /^cd(?:\s+(\S+))?$/.exec(cmd);
  if (cd) {
    const dest = cd[1] ?? "/home/tester";
    if (dest.startsWith("/nope")) {
      return { stdout: "", stderr: `bash: cd: ${dest}: No such file or directory` + "\n", exit: 1 };
    }
    state.cwd = dest === "~" ? "/home/tester" : dest;
    return { stdout: "", stderr: "", exit: 0 };
  }
  if (cmd === "pwd") return { stdout: state.cwd + "\n", stderr: "", exit: 0 };

  const echo = /^echo (.*)$/.exec(cmd);
  if (echo) return { stdout: `${echo[1]}\n`, stderr: "", exit: 0 };

  const ex = /^exit (\d+)$/.exec(cmd);
  if (ex) return { stdout: "", stderr: "", exit: Number(ex[1]) };

  return { stdout: "", stderr: "", exit: 0 };
}

type FakeChannel = EventEmitter & {
  write: (d: string | Buffer) => boolean;
  end: (d?: string | Buffer) => void;
  close: () => void;
};

/** 造一条假 channel：满足 ShellPipe 所需的 stdout/stderr/close/error 与 write/end/close */
function makeChannel(state: FakeShellState, mode: "shell" | "bash-n", loginDir: string): FakeChannel {
  // 新开的 channel 就是一次新的 exec：真实 sshd 会给一个新 shell，起始目录回到登录目录
  if (mode === "shell") {
    state.cwd = loginDir;
    state.shellChannels++;
  }
  const err = new Readable({ read(): void {} });
  const out = new Readable({ read(): void {} });
  const ch = new EventEmitter() as FakeChannel;
  const wrapped = ch as unknown as EventEmitter & ClientChannel;
  (wrapped as unknown as { stdout: Readable }).stdout = out;
  (wrapped as unknown as { stderr: Readable }).stderr = err;

  let buffer = "";
  let pendingCmd: string | null = null;

  const emitSentinel = (nonce: string, exit: number, cwd: string): void => {
    out.push(Buffer.from([1, ...Buffer.from("MCPEND", "utf8"), 1, ...Buffer.from(nonce, "utf8"), 1, ...Buffer.from(String(exit), "utf8"), 1, ...Buffer.from(cwd, "utf8"), 1]));
  };

  ch.write = (d: string | Buffer): boolean => {
    if (mode === "shell") feed(typeof d === "string" ? d : d.toString("utf8"));
    return true;
  };
  ch.end = (d?: string | Buffer): void => {
    if (!d) return;
    const text = typeof d === "string" ? d : d.toString("utf8");
    if (mode === "bash-n") {
      // 假 bash -n：引号不配对就报错退出（真实 bash 退出码 258）
      const bad = (text.match(/'/g)?.length ?? 0) % 2 === 1 || (text.match(/"/g)?.length ?? 0) % 2 === 1;
      setImmediate(() => {
        if (bad) err.push(Buffer.from("bash: -c: line 1: unexpected EOF while looking for matching quote" + String.fromCharCode(10), "utf8"));
        ch.emit("exit", bad ? 258 : 0);
        // 真实 ssh2 上不读空 stdout 时 close 永远不会到（实测），所以这里故意不发 close：
        // 预检必须在 exit 之后自行判定，不能等 channel 关闭。
      });
      return;
    }
    feed(text);
  };
  ch.close = (): void => {
    setImmediate(() => ch.emit("close"));
  };

  function feed(text: string): void {
    buffer += text;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!isSentinelLine(line)) {
        pendingCmd = line;
        continue;
      }
      const cmd = pendingCmd;
      pendingCmd = null;
      if (cmd === null) continue;
      const nonce = sentinelNonce(line);
      state.commands++;
      state.calls.push({ command: cmd, raw: cmd + "\n" + line });
      const r = handle(state, cmd);
      if (r.stdout) out.push(Buffer.from(r.stdout, "utf8"));
      if (r.stderr) err.push(Buffer.from(r.stderr, "utf8"));
      if (r.hang) continue; // 输出已到达但不回哨兵 -> 走调用方的超时分支
      if (r.close) {
        // shell 直接退出：不写哨兵，让调用方走「未能确定退出码」分支
        setImmediate(() => {
          ch.emit("exit", r.exit);
          ch.emit("close");
        });
        continue;
      }
      emitSentinel(nonce, r.exit, state.cwd);
    }
  }

  return ch;
}

/** 假 Client：只实现 exec；noBash 时 bash 系命令报 exec failure，用来验证退化到 sh */
export function makeFakeClient(opts: FakeShellOptions = {}): { client: Client; state: FakeShellState } {
  const loginDir = opts.initialCwd ?? "/home/tester";
  const state: FakeShellState = { cwd: loginDir, calls: [], commands: 0, execs: 0, shellChannels: 0 };

  const client = {
    exec(command: string, _options: unknown, cb: (err: Error | null, ch?: ClientChannel) => void): void {
      state.execs++;
      if (opts.noBash && command.startsWith("bash")) {
        cb(new Error("Cannot find command: bash"));
        return;
      }
      const ch = makeChannel(state, command === "bash -n -s" ? "bash-n" : "shell", loginDir);
      cb(null, ch as unknown as ClientChannel);
    },
    end(): void {},
    on(): void {},
  };
  return { client: client as unknown as Client, state };
}

export function fakeTarget(over: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return {
    alias: "fake",
    hostname: "127.0.0.1",
    port: 22,
    user: "tester",
    sources: ["test"],
    identityFiles: [],
    privateKeys: [],
    hostKeyPolicy: "tofu",
    ...over,
  };
}

/** 测试用临时文件路径（放在系统临时目录下，互不干扰） */
export function tmpFile(name: string): string {
  const dir = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/ssh-mcp-tests`;
  fs.mkdirSync(dir, { recursive: true });
  return `${dir}/${name}`;
}
