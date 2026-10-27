/**
 * 对外契约的错误契约：错误必须带 error_code（可枚举、可判定），而不只有一句人话。
 * 人话仍然保留在 error 字段里 —— 模型两种读法都要能读到。
 */
import { err, formatCause, formatError } from "./tool.ts";
import { localConfigPath, ResolveError, sshConfigPath } from "./config.ts";

/** 错误码枚举。命令 exit_code != 0 不在这里：那是数据，不是错误。 */
export type ErrorCode =
  | "bad_input" // 参数缺失、互斥、未知参数、未知 op
  | "unknown_host" // 主机名解析不出来
  | "connect_failed" // TCP/KEX 失败
  | "auth_failed" // 认证失败
  | "host_key_mismatch" // known_hosts 不匹配
  | "no_session" // 会话不存在或已被 TTL 回收
  | "not_found" // 远端/本地路径不存在
  | "permission" // 权限不足
  | "exists" // 目标已存在且未传 overwrite
  | "internal"; // 其它

/** 工具层内部抛出的、已经带好错误码与附加字段的业务错误 */
export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

/** 失败结果：isError=true，客户端会当成工具调用失败。成功侧仍用 tool.ts 的 ok()。 */
export function fail(code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
  return err({ error_code: code, error: message, ...extra });
}

/** 从异常造业务错误（给工具层 throw 用） */
export function bridgeError(code: ErrorCode, message: string, extra?: Record<string, unknown>): never {
  throw new BridgeError(code, message, extra ?? {});
}

/** 传输/文件系统类失败的归类：sftlops 的文案里已经有明确措辞，这里只做映射 */
export function classifyMessage(message: string): ErrorCode {
  const m = message.toLowerCase();
  if (/已存在|already|exists/.test(m)) return "exists";
  if (/不存在|no such file|not exist|enoent/.test(m)) return "not_found";
  if (/权限|permission/.test(m)) return "permission";
  if (/是目录|is a directory/.test(m)) return "bad_input";
  if (/超过传输上限|too large/.test(m)) return "bad_input";
  return "internal";
}

/** 未处理的异常 → 结构化错误。未知主机要顺带把可用主机递回去，省一次往返。 */
export function fromError(e: unknown, tool?: string): ReturnType<typeof err> {
  const withTool = (extra: Record<string, unknown>) => (tool ? { tool, ...extra } : extra);
  if (e instanceof BridgeError) {
    return fail(e.code, e.message, withTool(e.extra));
  }
  if (e instanceof ResolveError) {
    return fail(
      "unknown_host",
      e.message,
      withTool({
        available_hosts: e.available,
        ...(e.hint ? { hint: e.hint } : {}),
        ssh_config_path: sshConfigPath(),
        local_config_path: localConfigPath(),
      }),
    );
  }
  const cf = (
    e as Error & { connectFailure?: { reason: string; hint?: string; attempted_methods?: string[]; host_key_fingerprint?: string } }
  ).connectFailure;
  if (cf) {
    const reason = String(cf.reason ?? "");
    const code: ErrorCode = /host key|hostkey|主机密钥/.test(reason.toLowerCase())
      ? "host_key_mismatch"
      : /authenticat|认证/.test(reason.toLowerCase())
        ? "auth_failed"
        : "connect_failed";
    return fail(
      code,
      reason || "连接失败",
      withTool({
        ...(cf.hint ? { hint: cf.hint } : {}),
        attempted_methods: cf.attempted_methods ?? [],
        ...(cf.host_key_fingerprint ? { host_key_fingerprint: cf.host_key_fingerprint } : {}),
        ...formatCause(e),
      }),
    );
  }
  return fail("internal", formatError(e), withTool(formatCause(e)));
}
