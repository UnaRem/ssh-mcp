// 输出预算：远端输出可能很大，必须一边流式收集一边计数，
// 保证 truncated=true 时仍能回报截断前的真实字节数与行数。

const decoder = new TextDecoder("utf-8", { fatal: false });

function countNewlines(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return n;
}

/**
 * 收集一路输出。未超过 limit 时保留全文；超过后保留头部 60% 与滚动尾部 40%，
 * 但 total* 始终统计全量。
 */
export class OutputSink {
  totalBytes = 0;
  totalLines = 0;
  truncated = false;

  private full: Buffer[] = [];
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private headLimit: number;
  private tailLimit: number;

  constructor(private readonly limit: number) {
    this.headLimit = Math.ceil(limit * 0.6);
    this.tailLimit = limit - this.headLimit;
  }

  push(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    this.totalLines += countNewlines(chunk);

    if (!this.truncated) {
      this.full.push(chunk);
      if (this.totalBytes > this.limit) {
        this.truncated = true;
        const joined = Buffer.concat(this.full);
        this.full = [];
        this.head.push(joined.subarray(0, this.headLimit));
        this.headBytes = this.headLimit;
        this.appendTail(joined.subarray(joined.length - this.tailLimit));
      }
      return;
    }
    this.appendTail(chunk);
  }

  private appendTail(chunk: Buffer): void {
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > this.tailLimit) {
      const over = this.tailBytes - this.tailLimit;
      const first = this.tail[0]!;
      if (first.length <= over) {
        this.tailBytes -= first.length;
        this.tail.shift();
      } else {
        this.tail[0] = first.subarray(over);
        this.tailBytes -= over;
      }
    }
  }

  /** 归一化换行：远端为 Linux，正常只有 \n；防御性处理 \r\n */
  private static normalize(text: string): string {
    return text.replace(/\r\n/g, "\n");
  }

  text(): string {
    if (!this.truncated) return OutputSink.normalize(decoder.decode(Buffer.concat(this.full)));
    const dropped = this.totalBytes - this.headBytes - this.tailBytes;
    const head = OutputSink.normalize(decoder.decode(Buffer.concat(this.head)));
    const tail = OutputSink.normalize(decoder.decode(Buffer.concat(this.tail)));
    return (
      head +
      `\n\n[已截断：省略中间 ${dropped} 字节 / 共 ${this.totalBytes} 字节、${this.totalLines} 行]\n\n` +
      tail
    );
  }
}

/** 便捷构造一个空结果，字段齐全，避免调用方补漏 */
export function emptyResult(start: number): {
  ok: boolean;
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
} {
  return { ok: false, exit_code: null, duration_ms: Date.now() - start, timed_out: false };
}

/** 把 stdout/stderr 两个 sink 合并成结果里的输出字段 */
export function outputFields(out: OutputSink, err: OutputSink) {
  return {
    stdout: out.text(),
    stderr: err.text(),
    truncated: out.truncated || err.truncated,
    stdout_bytes: out.totalBytes,
    stdout_lines: out.totalLines,
    stderr_bytes: err.totalBytes,
    stderr_lines: err.totalLines,
  };
}

/** 默认输出预算：够看日志与命令输出，又不至于撑爆上下文 */
export const DEFAULT_MAX_OUTPUT_BYTES = 24_000;

export function clampBytes(v: number | undefined, fallback = DEFAULT_MAX_OUTPUT_BYTES): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(Math.floor(v), 1_000_000);
}

/** 本地路径的 ~ 展开，便于 put/get 直接使用 ~/x */
export function expandTilde(p: string): string {
  if (p === "~") return process.env.HOME ?? process.env.USERPROFILE ?? p;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (home) return home + p.slice(1);
  }
  return p;
}

/** 是否像二进制：出现 NUL 即判为二进制（够用于文本/日志/配置场景） */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
