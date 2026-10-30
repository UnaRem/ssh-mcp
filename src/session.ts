// 连续终端会话：在同一条 SSH 连接上跑一个远端 shell，命令通过 stdin 流入，
// 每条命令后自动追加「哨兵」帧来判定结束，同时带回退出码和当前工作目录。
//
// 为什么不用 -i/PTY：不加 PTY 时 stdout 与 stderr 是两条独立流，不需要解析
// 屏幕和 ANSI 噪声；shell 用 --norc --noprofile 避免启动脚本污染输出。
//
import { randomBytes } from "node:crypto";

import type { Client, ClientChannel } from "ssh2";

import { execAttached, type HostKeyInfo } from "./backend.ts";
import { clampBytes, DEFAULT_MAX_OUTPUT_BYTES, OutputSink } from "./result.ts";
// 默认超时只有一个来源：tool.ts（两处同名常量迟早会漂移）
import { DEFAULT_EXEC_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./tool.ts";
import type { ExecResult, ResolvedTarget } from "./types.ts";

const SEP = 0x01;
const TAG = "MCPEND";
const MARKER = Buffer.from(`\x01${TAG}\x01`, "utf8");
/** 帧未完整时最多预留多少字节不交给 sink（帧头 + 可能的长字段） */
const RESERVED = MARKER.length + 96;

const DEFAULT_IDLE_TTL = 180_000;

export function newNonce(): string {
  return randomBytes(6).toString("hex");
}

/** 单引号包裹，内部单引号按 POSIX 规则转义 */
export function quoteForSh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 追加在每条命令后的哨兵行：输出 \x01MCPEND\x01<nonce>\x01<exit>\x01<pwd>\x01
 * 参数必须用双引号：单引号会让 shell 不展开 $? 与 $PWD，退出码和工作目录就拿不回来了。
 */
export function sentinelLine(nonce: string): string {
  return `printf '\\001${TAG}\\001${nonce}\\001%s\\001%s\\001' "$?" "$PWD"\n`;
}

/** s 中是否有不在引号/转义里的 needle；`|` 会跳过 `||` */
function containsUnquoted(s: string, needle: string): boolean {
  const BS = String.fromCharCode(92);
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === BS) {
      i++;
      continue;
    }
    if (!inD && c === "'") {
      inS = !inS;
      continue;
    }
    if (!inS && c === '"') {
      inD = !inD;
      continue;
    }
    if (inS || inD) continue;
    if (s.startsWith(needle, i)) {
      if (needle === "|" && (s[i + 1] === "|" || s[i - 1] === "|")) {
        i++;
        continue;
      }
      return true;
    }
  }
  return false;
}

/** 命令最后一个片段（以 ; 、换行、&& 、|| 分隔）里是否有未加引号的管道 */
export function hasPipeInLastSegment(command: string): boolean {
  const NL = String.fromCharCode(10);
  const BS = String.fromCharCode(92);
  let inS = false;
  let inD = false;
  let segStart = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === BS) {
      i++;
      continue;
    }
    if (!inD && c === "'") {
      inS = !inS;
      continue;
    }
    if (!inS && c === '"') {
      inD = !inD;
      continue;
    }
    if (inS || inD) continue;
    if (c === ";" || c === NL) {
      segStart = i + 1;
      continue;
    }
    if (command.startsWith("&&", i) || command.startsWith("||", i)) {
      segStart = i + 2;
      i++;
    }
  }
  return containsUnquoted(command.slice(segStart), "|");
}

/**
 * 默认给命令补上 ` < /dev/null`，否则 cat / ssh / read 会读走后面写的哨兵。
 * 三种情况不追加：已有输入重定向或 heredoc；管道（追加重定向会把管道的输入
 * 改成 /dev/null，`echo hi | grep hi` 会被改坏）；调用方显式保留 stdin。
 */
export function guardStdin(command: string, keep = false): string {
  if (keep) return command;
  const trimmed = command.trimEnd();
  if (!trimmed) return command;
  if (/<<[-']?\s*\w/.test(trimmed)) return command; // heredoc
  if (/(^|[^<\d\w])<(?![<&(])/.test(trimmed)) return command; // 已有输入重定向
  if (trimmed.endsWith("&")) return command; // 后台任务本来就不等
  if (hasPipeInLastSegment(trimmed)) return command; // 管道命令：追加重定向会抢走管道输入
  return `${trimmed} < /dev/null`;
}

/** 便宜的本地语法可疑判定：命中才去远端跑 `bash -n`，避免每条命令多一次往返 */
export function looksSyntacticallySuspicious(command: string): string | null {
  const s = command;
  const counts = (needle: string, skipEscaped = true) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      if (skipEscaped && i > 0 && s[i - 1] === "\\") continue;
      if (s.startsWith(needle, i)) {
        n++;
        i += needle.length - 1;
      }
    }
    return n;
  };
  if (counts("'") % 2 !== 0) return "单引号未闭合";
  if (counts('"') % 2 !== 0) return "双引号未闭合";
  if (counts("`") % 2 !== 0) return "反引号未闭合";
  if (counts("(") !== counts(")")) return "括号不配对";
  if (counts("{") !== counts("}")) return "花括号不配对";
  if (/(^|[^\\])\\\s*$/.test(s)) return "以续行反斜杠结尾";
  // 结尾单个 & 是后台执行，合法；只有 && / || / | 结尾才算命令不完整
  if (/(&&|\|\||\|)\s*$/.test(s)) return "以连接符结尾，命令不完整";
  const heredoc = /<<[-']?\s*(\w+)/.exec(s);
  if (heredoc) {
    const term = heredoc[1]!;
    const lines = s.split("\n").slice(1).map((l) => l.trim());
    if (!lines.includes(term)) return `heredoc 缺少结束标记 ${term}`;
  }
  return null;
}

/**
 * 超时结果里「怎么把时长变成可控的」这一段。措辞只写一处，exec 与 batch 共用。
 * 「不会终止远端命令」不是推测：实测 2026-10-30 对 OpenSSH 9.6p1，
 * 一条 `sleep 12; touch f` 在 2s 超时（关闭通道）之后仍然跑完并创建了文件。
 * 要真的限制时长，原生做法是在命令里用 coreutils 的 timeout，或自己 kill/pkill。
 */
export function timeoutNote(timeoutMs: number): string {
  const sec = Math.max(1, Math.round(timeoutMs / 1000));
  return (
    "注意：关闭通道不会终止远端命令——它可能仍在远端继续运行（实测 2026-10-30）。" +
    `要限制时长就在命令里写 timeout ${sec} <命令>（或之后 kill/pkill 掉它）；` +
    `要后台执行请用 nohup ... >/dev/null 2>&1 &；要等更久就显式传更大的 timeout_ms（上限 ${MAX_TIMEOUT_MS}）。`
  );
}

interface Frame {
  nonce: string;
  exit: number | null;
  pwd: string;
  end: number;
}

function parseFrame(buf: Buffer, at: number): Frame | null {
  const after = at + MARKER.length;
  const iNonce = buf.indexOf(SEP, after);
  if (iNonce < 0) return null;
  const iExit = buf.indexOf(SEP, iNonce + 1);
  if (iExit < 0) return null;
  const iEnd = buf.indexOf(SEP, iExit + 1);
  if (iEnd < 0) return null;
  const nonce = buf.subarray(after, iNonce).toString("utf8");
  const rawExit = buf.subarray(iNonce + 1, iExit).toString("utf8").trim();
  const pwd = buf.subarray(iExit + 1, iEnd).toString("utf8");
  const n = Number(rawExit);
  return { nonce, exit: Number.isInteger(n) ? n : null, pwd, end: iEnd + 1 };
}

interface ActiveCall {
  nonce: string;
  out: OutputSink;
  start: number;
  resolve: (r: ActiveOutcome) => void;
}

interface ActiveOutcome {
  exit_code: number | null;
  pwd?: string;
  out: OutputSink;
  duration_ms: number;
}

/**
 * 一条命令一个往返的 shell 管道。任一时刻只有一条命令在飞，
 * 因此不需要处理多帧交错，代价是批量命令串行执行。
 */
export class ShellPipe {
  private pending = Buffer.alloc(0);
  private active: ActiveCall | null = null;
  dead = false;
  deadReason: string | null = null;
  /** 上一次调用因超时或异常结束，管道状态不可信，需要重开 */
  needsRestart = false;

  constructor(
    private readonly ch: ClientChannel,
    private readonly maxOut: number,
    private readonly onStderrChunk?: (b: Buffer) => void,
  ) {
    ch.stdout.on("data", (b: Buffer) => this.onData(b));
    ch.stderr.on("data", (b: Buffer) => this.onErr(b));
    ch.on("close", () => this.onEnd("远端 shell 已退出（可能命令里调用了 exit）"));
    ch.on("error", (err: Error) => this.onEnd(`shell 通道错误：${err.message}`));
  }

  private errSink = new OutputSink(clampBytes(undefined));

  private onErr(b: Buffer): void {
    this.errSink.push(b);
    this.onStderrChunk?.(b);
  }

  private onEnd(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.deadReason = reason;
    if (this.active) {
      const a = this.active;
      this.active = null;
      this.needsRestart = true;
      // 通道已经不会再送帧来了：把剩下的字节当数据交出，否则短输出必然看不见
      this.flushPendingTo(a.out);
      a.resolve({ exit_code: null, out: a.out, duration_ms: Date.now() - a.start });
    }
  }

  /**
   * 把「为凑齐哨兵帧而预留」的字节也交给 sink。只在放弃这条管道时用（超时、通道结束）。
   * 不这样做就会吞掉尾部不足 RESERVED（104 B）的输出：`echo BEFORE-OUT; sleep 40` 超时后
   * stdout 必然是空串（实测 2026-10-30，部署版就是这个现象）。
   */
  private flushPendingTo(sink: OutputSink): void {
    if (this.pending.length === 0) return;
    sink.push(this.pending);
    this.pending = Buffer.alloc(0);
  }

  private onData(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    this.drain();
  }

  private drain(): void {
    if (!this.active) {
      // 没有活动调用时到达的输出属于「超时后的残留」，丢掉但不破坏状态机
      if (this.pending.length > RESERVED) this.pending = this.pending.subarray(this.pending.length - RESERVED);
      return;
    }
    const idx = this.pending.indexOf(MARKER);
    if (idx < 0) {
      const safe = Math.max(0, this.pending.length - RESERVED);
      if (safe > 0) {
        this.active.out.push(this.pending.subarray(0, safe));
        this.pending = this.pending.subarray(safe);
      }
      return;
    }
    const frame = parseFrame(this.pending, idx);
    if (!frame) {
      if (idx > 0) this.active.out.push(this.pending.subarray(0, idx));
      this.pending = this.pending.subarray(idx);
      return;
    }
    if (frame.nonce !== this.active.nonce) {
      // 输出里恰好出现了同样的字节序列：当普通数据，继续往后找
      this.active.out.push(this.pending.subarray(0, idx + MARKER.length));
      this.pending = this.pending.subarray(idx + MARKER.length);
      this.drain();
      return;
    }
    this.active.out.push(this.pending.subarray(0, idx));
    const a = this.active;
    this.active = null;
    this.pending = this.pending.subarray(frame.end);
    a.resolve({ exit_code: frame.exit, pwd: frame.pwd, out: a.out, duration_ms: Date.now() - a.start });
  }

  /** 执行一条命令并等待它的哨兵帧 */
  run(command: string, timeoutMs: number, keepStdin = false, limitBytes?: number): Promise<ActiveOutcome & { timed_out: boolean; cwd?: string }> {
    if (this.dead || this.needsRestart) {
      return Promise.reject(new Error(this.deadReason ?? "管道不可用"));
    }
    const nonce = newNonce();
    const out = new OutputSink(clampBytes(limitBytes, this.maxOut));
    const start = Date.now();
    this.errSink = new OutputSink(clampBytes(undefined));

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.active) return;
        const a = this.active;
        this.active = null;
        // 先交付已到达的字节再判定超时：否则这一帧预留区里的输出永远进不了 stdout
        this.flushPendingTo(a.out);
        // 保留「换一条 shell」这个安全行为。注意：关通道不等于终止远端命令
        // （实测 2026-10-30，OpenSSH 9.6p1：被放弃的命令作为孤儿进程继续跑完），
        // 这条事实写进 exec() 的 error 文案，不在这里下结论。
        this.needsRestart = true;
        resolve({ exit_code: null, out, duration_ms: Date.now() - start, timed_out: true });
      }, timeoutMs);

      this.active = {
        nonce,
        out,
        start,
        resolve: (r) => {
          clearTimeout(timer);
          resolve({ ...r, cwd: r.pwd, timed_out: false });
        },
      };
      this.ch.write(`${guardStdin(command, keepStdin)}\n${sentinelLine(nonce)}`);
    });
  }

  currentStderr(): OutputSink {
    return this.errSink;
  }

  close(): void {
    try {
      this.ch.end();
      this.ch.close();
    } catch {}
    this.dead = true;
  }
}

/** 在远端用 `bash -n` 做语法预检；不执行命令，也不影响现有会话 */
export function syntaxCheck(conn: Client, command: string, timeoutMs = 8_000): Promise<{ ok: boolean; stderr: string }> {
  const err = new OutputSink(4000);
  let code: number | null = null;
  let ch: ClientChannel | null = null;
  let grace: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  return new Promise((resolve) => {
    const finish = (ok: boolean, why = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (ch) {
        try {
          ch.close();
        } catch {}
      }
      resolve({ ok, stderr: err.text() || why });
    };
    const timer = setTimeout(() => finish(false, "bash -n 预检超时"), timeoutMs);
    // 监听必须在 exec 回调里同步挂：语法合法的输入会在同一刻就退出，异步挂会错过事件
    execAttached(conn, "bash -n -s", {}, (c) => {
      ch = c;
      // 必须把 stdout 读空：不消费的话 Node 流的可读侧不会结束，channel 的 close 永远不发
      // （实测远端 bash -n 在几毫秒内就 exit，但 close 一直不来，只能等到超时）
      if (typeof (c as { resume?: unknown }).resume === "function") c.resume();
      c.stderr.on("data", (b: Buffer) => err.push(b));
      c.on("exit", (c2: number | null) => {
        // exit 往往先到、stderr 还在路上：留一小段宽限期把报错收完再判定
        code = c2;
        grace = setTimeout(() => finish(code === 0), 250);
      });
      // stderr 已收完且已知退出码就立刻判定，不必等 channel 关闭
      c.stderr.on("end", () => {
        if (code !== null) finish(code === 0);
      });
      c.on("close", () => finish(code === 0));
      c.on("error", () => finish(code !== null && code === 0, "bash -n 预检通道异常"));
      c.end(command + "\n");
    }).catch((e: Error) => finish(false, `无法执行语法预检：${e.message}`));
  });
}

/** 打开远端 shell：优先 bash，缺失时退化为 sh（POSIX 下 $?/$PWD 语义一致）。 */
export async function openShellChannel(
  conn: Client,
  env: Record<string, string>,
  attach?: (ch: ClientChannel) => void,
): Promise<string> {
  let lastError: Error | null = null;
  for (const shell of ["bash --norc --noprofile -s", "sh -s"]) {
    try {
      await execAttached(conn, shell, env, attach);
      return shell;
    } catch (e) {
      lastError = e as Error;
      if (/Cannot find|exec failure|not found/i.test(lastError.message) && shell !== "sh -s") continue;
      throw e;
    }
  }
  throw lastError ?? new Error("远端没有可用的 shell");
}

export interface SessionOpenOptions {
  /** 自定义会话 id；不给则自动生成 */
  sessionId?: string;
  cwd?: string;
  env?: Record<string, string>;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

/** 一个可复用的远端 shell。状态（cwd、export、函数）跨调用保持。 */
export class ShellSession {
  pipe: ShellPipe;
  shell: string;
  cwd: string;
  createdAt = Date.now();
  lastUsed = Date.now();
  closed = false;
  /** 供结果里说明该会话会保持状态 */
  readonly stateful = true;
  /** 该会话的输出预算，构造后由 create() 写入，重开会话时沿用 */
  maxOutputBytes: number = DEFAULT_MAX_OUTPUT_BYTES;
  private constructor(
    readonly id: string,
    readonly target: ResolvedTarget,
    private readonly conn: Client,
    pipe: ShellPipe,
    shell: string,
    cwd: string,
  ) {
    this.pipe = pipe;
    this.shell = shell;
    this.cwd = cwd;
  }

  static async open(id: string, target: ResolvedTarget, conn: Client, opts: SessionOpenOptions = {}): Promise<ShellSession> {
    const maxOut = clampBytes(opts.maxOutputBytes);
    const env: Record<string, string> = { ...(opts.env ?? {}) };
    let pipe: ShellPipe | undefined;
    const shell = await openShellChannel(conn, env, (ch) => {
      pipe = new ShellPipe(ch, maxOut);
    });
    if (!pipe) throw new Error("无法打开远端 shell");
    const session = new ShellSession(id, target, conn, pipe, shell, "");
    session.maxOutputBytes = maxOut;
    // 探针：拿到初始 cwd，顺便验证管道可用
    const probe = await session.pipe.run("pwd", opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
    session.cwd = probe.cwd ?? "";
    if (opts.cwd) {
      const cd = await session.pipe.run(`cd ${quoteForSh(opts.cwd)}`, opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
      if (cd.exit_code !== 0) {
        const errText = session.pipe.currentStderr().text();
        session.close();
        throw new Error(`无法进入目录 ${opts.cwd}：${errText || `退出码 ${cd.exit_code}`}`);
      }
      session.cwd = cd.cwd ?? session.cwd;
    }
    return session;
  }

  get idleMs(): number {
    return Date.now() - this.lastUsed;
  }

  /** 执行一条命令。语法可疑时先做 bash -n 预检，预检失败则不污染会话。 */
  async exec(command: string, opts: { timeoutMs?: number; maxOutputBytes?: number; keepStdin?: boolean } = {}): Promise<ExecResult> {
    const start = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const syntax = looksSyntacticallySuspicious(command);

    if (syntax) {
      const check = await syntaxCheck(this.conn, command, Math.min(timeoutMs, 8_000));
      if (!check.ok) {
        return {
          ok: false,
          exit_code: null,
          stdout: "",
          stderr: check.stderr || `语法预检未通过：${syntax}`,
          duration_ms: Date.now() - start,
          timed_out: false,
          truncated: false,
          stdout_bytes: 0,
          stdout_lines: 0,
          stderr_bytes: Buffer.byteLength(check.stderr || syntax),
          stderr_lines: 1,
          error: `命令未执行：${syntax}（已用 bash -n 确认）。会话状态未被改动。`,
          syntax_check: "failed",
          session_id: this.id,
          cwd: this.cwd,
        };
      }
    }

    if (this.pipe.needsRestart || this.pipe.dead) {
      await this.restart();
    }

    const r = await this.pipe.run(command, timeoutMs, opts.keepStdin === true, opts.maxOutputBytes);
    const err = this.pipe.currentStderr();
    this.lastUsed = Date.now();
    const outFields = {
      stdout: r.out.text(),
      stderr: err.text(),
      truncated: r.out.truncated || err.truncated,
      stdout_bytes: r.out.totalBytes,
      stdout_lines: r.out.totalLines,
      stderr_bytes: err.totalBytes,
      stderr_lines: err.totalLines,
    };

    if (r.timed_out) {
      // 哨兵没出现：后台进程占住 fd，或命令吞掉了 stdin
      await this.restart();
      return {
        ok: false,
        exit_code: null,
        ...outFields,
        duration_ms: Date.now() - start,
        timed_out: true,
        background_suspect: true,
        session_restarted: true,
        error:
          `等待 ${timeoutMs}ms 未收到命令结束标记，已停止等待并关闭该通道；stdout 里是超时之前实际产生的输出。` +
          `可能原因：后台进程占住 stdout/stderr、命令读取了 stdin、或命令本来就要跑这么久。` +
          timeoutNote(timeoutMs) +
          "会话已重开（cwd 与 export 已清空）。若要读文件请用 cat < file。",
        session_id: this.id,
        cwd: this.cwd,
        syntax_check: syntax ? "passed" : undefined,
      };
    }

    if (r.exit_code === null) {
      await this.restart();
      return {
        ok: false,
        exit_code: null,
        ...outFields,
        duration_ms: Date.now() - start,
        timed_out: false,
        session_restarted: true,
        error: this.pipe.deadReason ?? "未能确定退出码，会话已重开",
        session_id: this.id,
        cwd: this.cwd,
        syntax_check: syntax ? "passed" : undefined,
      };
    }

    if (r.cwd) this.cwd = r.cwd;
    return {
      ok: r.exit_code === 0,
      exit_code: r.exit_code,
      ...outFields,
      duration_ms: Date.now() - start,
      timed_out: false,
      session_id: this.id,
      cwd: this.cwd,
      ...(syntax ? { syntax_check: "passed" as const } : {}),
    };
  }

  /** 重开 shell：丢弃 cwd 与用户 export，回到登录初始目录 */
  async restart(): Promise<void> {
    this.pipe.close();
    let pipe: ShellPipe | undefined;
    const shell = await openShellChannel(this.conn, {}, (ch) => {
      pipe = new ShellPipe(ch, this.maxOutputBytes);
    });
    if (!pipe) throw new Error("无法重开远端 shell");
    this.pipe = pipe;
    this.shell = shell;
    const probe = await this.pipe.run("pwd", DEFAULT_EXEC_TIMEOUT_MS);
    this.cwd = probe.cwd ?? "";
    this.needsRestartFlagOff();
  }

  private needsRestartFlagOff(): void {
    // ShellPipe 新建即 needsRestart=false，这里只是为了让调用点意图明确
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pipe.close();
  }
}

/** 会话登记处：空闲超过 TTL 自动关闭；下次调用会明确报告过期原因 */
export class SessionManager {
  private sessions = new Map<string, ShellSession>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** 被 TTL 回收的会话：保留原因，下次调用同一个 id 时要能说明 */
  private reaped = new Map<string, { idle_ms: number; ttl_ms: number; at: number }>();
  readonly idleTtlMs: number;

  constructor(idleTtlMs = DEFAULT_IDLE_TTL) {
    this.idleTtlMs = idleTtlMs;
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(30_000, Math.max(1_000, idleTtlMs / 2)));
    // 不阻止进程退出
    (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  get(id: string): ShellSession | undefined {
    return this.sessions.get(id);
  }

  async create(target: ResolvedTarget, conn: Client, opts: SessionOpenOptions = {}): Promise<ShellSession> {
    const id = opts.sessionId ?? `s_${Date.now().toString(36)}_${newNonce()}`;
    const s = await ShellSession.open(id, target, conn, opts);
    this.sessions.set(id, s);
    this.reaped.delete(id);
    return s;
  }

  close(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.close();
    this.sessions.delete(id);
    return true;
  }

  list(): { session_id: string; host: string; cwd: string; idle_ms: number; shell: string }[] {
    return [...this.sessions.values()].map((s) => ({
      session_id: s.id,
      host: `${s.target.user}@${s.target.hostname}:${s.target.port}`,
      cwd: s.cwd,
      idle_ms: s.idleMs,
      shell: s.shell,
    }));
  }

  /** 返回被 TTL 回收的会话，供调用处报告原因 */
  sweep(): { session_id: string; idle_ms: number }[] {
    const expired: { session_id: string; idle_ms: number }[] = [];
    for (const [id, s] of this.sessions) {
      if (s.idleMs > this.idleTtlMs) {
        expired.push({ session_id: id, idle_ms: s.idleMs });
        this.reaped.set(id, { idle_ms: s.idleMs, ttl_ms: this.idleTtlMs, at: Date.now() });
        s.close();
        this.sessions.delete(id);
      }
    }
    return expired;
  }

  /** 该 id 是否已被空闲回收；用于在下次调用时明确回报原因 */
  reapInfo(id: string): { idle_ms: number; ttl_ms: number; at: number } | undefined {
    return this.reaped.get(id);
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
