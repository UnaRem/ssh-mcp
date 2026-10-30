/**
 * 一次性执行与批处理的离线测试：验证「结构化可判定」这条主线——
 * 退出码、stdout/stderr 分离、超时、截断、cwd，以及 batch 只付一次连接/一个 shell 的成本。
 *
 * 注意：ShellSession.open() 会先发一条 pwd 探针取起始目录，所以 fake 的 commands 计数
 * 恒等于「探针 1 + 实际执行的命令数」；重开会话（background_suspect）会再多一次探针。
 */
import { describe, expect, test } from "bun:test";

import { DEFAULT_MAX_STEPS, runBatch, runOnce } from "../src/exec.ts";
import { fakeTarget, makeFakeClient } from "./helpers.ts";

describe("runOnce（ssh_exec 的执行核）", () => {
  test("成功命令返回 exit_code=0、stdout 与起始 cwd", async () => {
    const { client, state } = makeFakeClient();
    const r = await runOnce(fakeTarget(), client, "echo hello");
    expect(r.ok).toBe(true);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toBe("hello\n");
    expect(r.stderr).toBe("");
    expect(r.timed_out).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.cwd).toBe("/home/tester");
    // 一次性调用不应把临时 session_id 泄漏给调用方
    expect(r.session_id).toBeUndefined();
    expect(state.shellChannels).toBe(1);
    expect(state.commands).toBe(2); // 探针 + 命令
  });

  test("命令失败不是工具错误：exit_code 与 stderr 分开返回", async () => {
    const { client } = makeFakeClient();
    const r = await runOnce(fakeTarget(), client, "exit 7");
    expect(r.ok).toBe(false);
    expect(r.exit_code).toBe(7);
    expect(r.timed_out).toBe(false);
    const r2 = await runOnce(fakeTarget(), client, "cd /nope/x");
    expect(r2.exit_code).toBe(1);
    expect(r2.stderr).toContain("No such file or directory");
    expect(r2.stdout).toBe("");
  });

  test("吞 stdin 的命令自动补 < /dev/null；keep_stdin=true 时原样送", async () => {
    const { client, state } = makeFakeClient();
    await runOnce(fakeTarget(), client, "cat notes.txt");
    const guarded = state.calls.filter((c) => c.command.includes("cat notes.txt"));
    expect(guarded.length).toBe(1);
    expect(guarded[0]?.command).toBe("cat notes.txt < /dev/null");
    const kept = await runOnce(fakeTarget(), client, "cat notes.txt", { keepStdin: true });
    expect(kept.exit_code).toBe(0);
    const last = state.calls.filter((c) => c.command.includes("cat notes.txt")).at(-1);
    expect(last?.command).toBe("cat notes.txt");
  });

  test("输出超预算时 truncated=true 并回报全量字节/行数", async () => {
    const { client } = makeFakeClient();
    const big = "A".repeat(4000);
    const r = await runOnce(fakeTarget(), client, `echo ${big}`, { maxOutputBytes: 200 });
    expect(r.truncated).toBe(true);
    // 只保留首尾片段 + 截断说明，中间被省略
    expect(r.stdout).toContain("[已截断：省略中间");
    expect(r.stdout.startsWith("AAAA")).toBe(true);
    expect(r.stdout.trimEnd().endsWith("AAAA")).toBe(true);
    expect(r.stdout.length).toBeLessThan(500);
    expect(r.stdout_bytes).toBe(4001);
    expect(r.stdout_lines).toBe(1);
    expect(r.exit_code).toBe(0);
  });

  test("哨兵超时（后台挂住 fd）返回 timed_out + background_suspect，不抛异常", async () => {
    const { client } = makeFakeClient();
    const started = Date.now();
    const r = await runOnce(fakeTarget(), client, "#hang", { timeoutMs: 400 });
    expect(r.timed_out).toBe(true);
    expect(r.background_suspect).toBe(true);
    expect(r.session_restarted).toBe(true);
    expect(r.exit_code).toBeNull();
    expect(r.error).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test("超时结果自解释：带回超时前的部分输出 + 说明远端命令不会被终止", async () => {
    const { client } = makeFakeClient();
    // 用户给的复现，换成离线替身：先输出一行，再挂住不回哨兵
    const r = await runOnce(fakeTarget(), client, "#hang BEFORE-OUT", { timeoutMs: 300 });
    expect(r.timed_out).toBe(true);
    expect(r.stdout).toContain("BEFORE-OUT");
    expect(r.stdout).not.toContain("AFTER-OUT");
    expect(String(r.error)).toContain("不会终止远端命令");
    expect(String(r.error)).toContain("nohup");
    expect(String(r.error)).toContain("timeout_ms");
  });

  test("语法可疑的命令先做 bash -n 预检，未执行且不改动会话", async () => {
    const { client, state } = makeFakeClient();
    const r = await runOnce(fakeTarget(), client, "echo '未闭合");
    expect(r.exit_code).toBeNull();
    expect(r.error).toContain("命令未执行");
    expect(r.syntax_check).toBe("failed");
    expect(r.stderr).toContain("unexpected EOF");
    // 先开 shell（含 pwd 探针），再额外开一个 bash -n 预检通道；命令本身没进 shell
    expect(state.shellChannels).toBe(1);
    expect(state.execs).toBe(2);
    expect(state.commands).toBe(1);
  });
});

describe("runBatch（ssh_batch 的执行核）", () => {
  test("多步在同一条连接、同一个 shell 内完成，cd 在批次内有效", async () => {
    const { client, state } = makeFakeClient();
    const r = await runBatch(fakeTarget(), client, ["cd /tmp", "pwd"]);
    expect(r.ok).toBe(true);
    expect(r.connection_reused).toBe(true);
    expect(r.steps.length).toBe(2);
    expect(r.steps[0]).toMatchObject({ index: 0, command: "cd /tmp", exit_code: 0 });
    expect(r.steps[1]).toMatchObject({ index: 1, command: "pwd", exit_code: 0, stdout: "/tmp\n" });
    expect(r.cwd).toBe("/tmp");
    expect(r.shell).toContain("-s");
    // 关键收益：一次 exec（一个 shell），两步命令；只多一条 pwd 探针
    expect(state.execs).toBe(1);
    expect(state.shellChannels).toBe(1);
    expect(state.commands).toBe(3);
  });

  test("逐步报告退出码，某步失败不影响后续步骤（默认不中断）", async () => {
    const { client } = makeFakeClient();
    const r = await runBatch(fakeTarget(), client, ["exit 3", "echo after"]);
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => s.exit_code)).toEqual([3, 0]);
    expect(r.steps[1]?.stdout).toBe("after\n");
    expect(r.stopped_at).toBeUndefined();
  });

  test("stop_on_error=true 时首个失败即停止并说明停在哪一步", async () => {
    const { client, state } = makeFakeClient();
    const r = await runBatch(fakeTarget(), client, ["exit 3", "echo after"], { stopOnError: true });
    expect(r.ok).toBe(false);
    expect(r.steps.length).toBe(1);
    expect(r.stopped_at).toBe("stop_on_error_at_step_0");
    expect(state.commands).toBe(2); // 探针 + 第一步
  });

  test("某步超时即停止，后续步骤不再执行", async () => {
    const { client, state } = makeFakeClient();
    const r = await runBatch(fakeTarget(), client, ["#hang", "echo after"], { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.steps.length).toBe(1);
    expect(r.steps[0]?.timed_out).toBe(true);
    expect(r.stopped_at).toBe("step_0_timeout");
    expect(state.commands).toBe(3); // 探针 + 挂住的命令 + 重开会话的探针
  });

  test("批次因超时停止时带 hint：停在哪一步、命令不会被终止、怎么控制时长", async () => {
    const { client } = makeFakeClient();
    const r = await runBatch(fakeTarget(), client, ["#hang AFTER-HANG", "echo after"], { timeoutMs: 300 });
    expect(r.stopped_at).toBe("step_0_timeout");
    // 已产生的输出在该步的 stdout 里，不因为是超时就被丢掉
    expect(r.steps[0]?.stdout).toContain("AFTER-HANG");
    expect(r.steps[1]).toBeUndefined();
    const hint = String(r.hint);
    expect(hint).toContain("第 0 步");
    expect(hint).toContain("不会终止远端命令");
    expect(hint).toContain("nohup");
    expect(hint).toContain("timeout_ms");
  });

  test("超过 maxSteps 的步数被丢弃：回报 dropped 且不报 ok", async () => {
    const { client } = makeFakeClient();
    const cmds = ["echo a", "echo b", "echo c"];
    const r = await runBatch(fakeTarget(), client, cmds, { maxSteps: 2 });
    expect(r.steps.length).toBe(2);
    expect(r.dropped).toBe(1);
    expect(r.ok).toBe(false);
    expect(DEFAULT_MAX_STEPS).toBeGreaterThan(3);
  });

  test("任一步截断则整批 truncated=true，并保留该步全量字节数", async () => {
    const { client } = makeFakeClient();
    const r = await runBatch(fakeTarget(), client, ["echo ok", `echo ${"B".repeat(3000)}`], { maxOutputBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(r.steps[0]?.truncated).toBe(false);
    expect(r.steps[1]?.truncated).toBe(true);
    expect(r.steps[1]?.stdout_bytes).toBe(3001);
  });

  test("空命令列表：只建立 shell，不执行任何命令", async () => {
    const { client, state } = makeFakeClient();
    const r = await runBatch(fakeTarget(), client, []);
    expect(r.steps).toEqual([]);
    expect(r.ok).toBe(true);
    expect(state.commands).toBe(1);
  });
});
