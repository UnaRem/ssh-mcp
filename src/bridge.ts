/**
 * 门面（桥）与内部上下文之间的边界。
 *
 * 工具层只通过 BridgeCtx 访问内部上下文（主机解析、连接池、会话登记、SFTP 通道），
 * 不直接 import 实现模块 —— 这样「对外只有一层桥」是可以检查的，而不是靠约定。
 * docs/domain.md 里的分界线就是这一层。
 */
import type { SFTPWrapper } from "ssh2";
import type { z } from "zod";

import type { ConnHandle } from "./backend.ts";
import type { TargetInput } from "./config.ts";
import { clampBytes, DEFAULT_MAX_OUTPUT_BYTES } from "./result.ts";
import type { SessionManager } from "./session.ts";
import { clampTimeout } from "./tool.ts";
import type { ResolvedTarget } from "./types.ts";

/** 一次取用连接的结果：reused 必须回报，「一次调用至多新建一条连接」是这条边界的硬约束 */
export interface Acquired {
  target: ResolvedTarget;
  conn: ConnHandle;
  reused: boolean;
}

export interface BridgeCtx {
  /** 默认执行超时，来自环境变量覆盖后的实际值 */
  execTimeoutMs: number;
  /** 会话空闲回收周期，用于在结果里说明会话能保留多久 */
  sessionTtlMs: number;
  acquire(input: TargetInput): Promise<Acquired>;
  /** 连接与 host key 的元信息：TOFU 追加、认证顺序这些必须能在结果里看到 */
  connMeta(a: Acquired): Record<string, unknown>;
  /** 连接池里那条连接的池键（同一主机会话复用它） */
  hostKeyOf(target: ResolvedTarget): string;
  openSftp(conn: ConnHandle): Promise<SFTPWrapper>;
  sessions: SessionManager;
  /** 自省：可用主机、配置来源、活动连接与会话。不传参数就能拿到，省一次「先问有哪些主机」的调用 */
  inventory(): Record<string, unknown>;
}

/** 工具定义：schema 与 handler 成对出现，关键词属于工具本身而不是注册处的一张表 */
export interface ToolDef {
  name: string;
  title: string;
  /** 面向模型的功能说明；检索关键词由 keywords 单独给出，注册时拼在一起 */
  description: string;
  keywords: string;
  shape: Record<string, z.ZodTypeAny>;
  handler(ctx: BridgeCtx, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** 把可选的执行控制参数规整成实现层要的形状（都有安全默认值） */
export function runOptions(ctx: BridgeCtx, a: { timeout_ms?: number; max_output_bytes?: number }) {
  return {
    timeoutMs: clampTimeout(a.timeout_ms, ctx.execTimeoutMs),
    maxOutputBytes: clampBytes(a.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES),
  };
}
