/**
 * 超时上限的契约。要锁的结论只有一条：这层桥不承诺「等更久」。
 *
 * 依据（实测 2026-11-05，本机 OpenCode 历史 841 次真实调用）：
 *   83% 的调用本来就在 5s 内完成（p50 0.18s）；超过 5s 的 140 次里 68 次是 sleep/轮询等待，
 *   也就是「姿势错」而不是「活真的需要那么久」。所以默认与上限同值，长活一律 nohup 起后台再轮询。
 * 配套的两条不变量：
 *   1) 超出上限的值只截不拒。由 schema 的 maximum 拒绝的话，SDK 在进 handler 之前抛，
 *      返回没有 structuredContent，命令也不会执行（历史里约 300 次传了 30s 以上，整段作废）。
 *   2) 截断这件事必须在结果里可见（timeout_capped），否则模型以为自己的 300000 生效了。
 */
import { describe, expect, test } from "bun:test";

import type { BridgeCtx } from "../src/bridge.ts";
import { runOptions } from "../src/bridge.ts";
import { timeoutNote } from "../src/session.ts";
import { clampTimeout, DEFAULT_EXEC_TIMEOUT_MS, MAX_TIMEOUT_MS } from "../src/tool.ts";

/** runOptions 只读 execTimeoutMs，这里不需要整条连接池 */
const ctx = { execTimeoutMs: DEFAULT_EXEC_TIMEOUT_MS, sessions: { idleTtlMs: 0 } } as unknown as BridgeCtx;

describe("超时上限：默认即上限", () => {
  test("默认值与上限是同一个数，漂移不可能发生", () => {
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(5_000);
    expect(MAX_TIMEOUT_MS).toBe(DEFAULT_EXEC_TIMEOUT_MS);
  });

  test("超出上限只截不拒；调小是这条参数唯一的用途", () => {
    expect(clampTimeout(600_000, DEFAULT_EXEC_TIMEOUT_MS)).toBe(5_000);
    expect(clampTimeout(undefined, DEFAULT_EXEC_TIMEOUT_MS)).toBe(5_000);
    expect(clampTimeout(1_000, DEFAULT_EXEC_TIMEOUT_MS)).toBe(1_000);
  });

  test("被截断在结果里可见：生效值、原请求值、capped 标记", () => {
    const o = runOptions(ctx, { timeout_ms: 300_000 });
    expect(o.timeoutMs).toBe(5_000);
    expect(o.timeout_meta).toEqual({ timeout_ms: 5_000, timeout_ms_requested: 300_000, timeout_capped: true });
  });

  test("没传、或传了上限内的值，都不带 timeout_meta", () => {
    expect(runOptions(ctx, {}).timeout_meta).toBeUndefined();
    expect(runOptions(ctx, { timeout_ms: 2_000 }).timeout_meta).toBeUndefined();
  });
});

describe("超时文案：不给「等更久」留退路", () => {
  test("文案改指向 nohup，且仍带 timeout_ms 这个词供检索", () => {
    const note = timeoutNote(5_000);
    expect(note).toContain("nohup");
    expect(note).toContain("tail -n");
    expect(note).toContain("timeout_ms");
    // 旧文案的「传更大的 timeout_ms」在这条契约下不成立，出现即回归
    expect(note).not.toMatch(/更大的\s*timeout_ms/);
  });
});
