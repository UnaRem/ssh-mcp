/**
 * 工具层共用的返回约定与参数校验。
 * 关键：命令失败（exit_code != 0）也是「成功的工具调用」，把 exit_code/stderr 作为数据返回，
 * 只有连接/协议/参数错误才 isError=true —— 这样 agent 能对结果做判定而不是猜。
 */
import { z } from "zod";

export const VERSION = "0.1.0";

export const DEFAULT_READY_TIMEOUT_MS = 12_000;
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_TTL_MS = 600_000;
export const MAX_TIMEOUT_MS = 600_000;
export const MAX_COMMAND_CHARS = 20_000;

export function clampTimeout(v: number | undefined, dflt: number): number {
  if (v === undefined || !Number.isFinite(v)) return dflt;
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(v)));
}

/** 参数校验工具：把 zod schema 的失败转成一句可操作的提示 */
export function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  const r = schema.safeParse(args ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path?.join(".") || "(根对象)";
    throw new Error(`参数无效于 ${where}: ${first?.message ?? "未知错误"}`);
  }
  return r.data;
}

/** 工具返回值：各工具自带的字段直接透传，ok 由包装器统一补齐 */
export type ToolPayload = Record<string, unknown>;

export function ok(payload: ToolPayload) {
  // 默认 ok:true，但工具自己给出的 ok 优先：命令 exit_code != 0、传输有条目失败时
  // 顶层必须是 false（那是数据，同时也不该被包装器抹平成成功）。
  const body = { ok: true, ...payload };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
  };
}

export function err(payload: ToolPayload) {
  const body = { ...payload, ok: false };  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    isError: true,
  };
}

export function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** ssh2 的失败原因常常在 cause / 自定义字段里，一并取出避免只报 All configured authentication methods failed */
export function formatCause(e: unknown): Record<string, unknown> {
  if (!(e instanceof Error)) return {};
  const out: Record<string, unknown> = {};
  const anyE = e as Error & Record<string, unknown>;
  if (anyE.level) out.level = String(anyE.level);
  if (anyE.cause instanceof Error) {
    out.cause = `${anyE.cause.name}: ${anyE.cause.message}`;
    const c = anyE.cause as Error & Record<string, unknown>;
    if (c.level) out.cause_level = String(c.level);
  } else if (anyE.cause) {
    out.cause = String(anyE.cause);
  }
  if (anyE.hostKeyDiff) out.host_key_diff = String(anyE.hostKeyDiff);
  return out;
}
