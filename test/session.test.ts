// 连续终端会话（哨兵协议）的离线测试：不联网，用 test/helpers.ts 里的假 shell。
import { describe, expect, test } from "bun:test";

import { ShellSession, SessionManager, guardStdin, looksSyntacticallySuspicious } from "../src/session.ts";
import { fakeTarget, makeFakeClient } from "./helpers.ts";

describe("guardStdin", () => {
  test("默认补 < /dev/null，已有重定向与后台任务不补", () => {
    expect(guardStdin("cat")).toBe("cat < /dev/null");
    expect(guardStdin("cat < file")).toBe("cat < file");
    expect(guardStdin("cat <<EOF\\nhi\\nEOF")).toBe("cat <<EOF\\nhi\\nEOF");
    expect(guardStdin("sleep 5 &")).toBe("sleep 5 &");
    expect(guardStdin("read x", true)).toBe("read x");
  });

  test("管道命令不补重定向：否则管道里的 stdin 被改成 /dev/null", () => {
    expect(guardStdin("head -c 4096 /dev/zero | wc -c")).toBe("head -c 4096 /dev/zero | wc -c");
    expect(guardStdin("echo hi | grep hi")).toBe("echo hi | grep hi");
    expect(guardStdin("a || b")).toBe("a || b < /dev/null"); // || 不是管道
    expect(guardStdin("echo 'a|b'")).toBe("echo 'a|b' < /dev/null"); // 引号里的 | 不算
    expect(guardStdin("cd /tmp; cat")).toBe("cd /tmp; cat < /dev/null"); // 只看最后一段
    expect(guardStdin("ls | wc -l; echo done")).toBe("ls | wc -l; echo done < /dev/null");
  });
});

describe("looksSyntacticallySuspicious", () => {
  test("未闭合引号与以连接符结尾会被拦下", () => {
    expect(looksSyntacticallySuspicious("echo 'abc")).toBe("单引号未闭合");
    expect(looksSyntacticallySuspicious('echo "abc')).toBe("双引号未闭合");
    expect(looksSyntacticallySuspicious("echo a |")).toBe("以连接符结尾，命令不完整");
    expect(looksSyntacticallySuspicious("ls &&")).toBe("以连接符结尾，命令不完整");
  });

  test("结尾单个 & 是后台执行，合法", () => {
    expect(looksSyntacticallySuspicious("sleep 5 &")).toBeNull();
    expect(looksSyntacticallySuspicious("echo ok")).toBeNull();
    expect(looksSyntacticallySuspicious("echo \\; done")).toBeNull();
  });
});

describe("ShellSession", () => {
  test("状态跨调用保持：cd 之后 pwd 与 cwd 字段一致", async () => {
    const { client } = makeFakeClient({ initialCwd: "/home/tester" });
    const s = await ShellSession.open("s1", fakeTarget(), client);
    expect(s.shell).toBe("bash --norc --noprofile -s");
    expect(s.cwd).toBe("/home/tester");

    const cd = await s.exec("cd /tmp");
    expect(cd.exit_code).toBe(0);
    expect(cd.cwd).toBe("/tmp");

    const pwd = await s.exec("pwd");
    expect(pwd.stdout).toBe("/tmp\n");
    expect(pwd.cwd).toBe("/tmp");

    s.close();
  });

  test("命令失败不算异常：退出码与 stderr 分开返回", async () => {
    const { client } = makeFakeClient();
    const s = await ShellSession.open("s2", fakeTarget(), client);
    const r = await s.exec("cd /nope/missing");
    expect(r.ok).toBe(false);
    expect(r.exit_code).toBe(1);
    expect(r.stderr).toContain("No such file or directory");
    expect(r.cwd).toBe("/home/tester");
    s.close();
  });

  test("吞 stdin 的命令被补 < /dev/null 后不会挂住", async () => {
    const { client, state } = makeFakeClient();
    const s = await ShellSession.open("s3", fakeTarget(), client);
    const r = await s.exec("cat");
    expect(r.timed_out).toBe(false);
    expect(state.calls.some((c) => c.command === "cat < /dev/null")).toBe(true);
    s.close();
  });

  test("语法不完整：先 bash -n 预检，不执行也不污染会话", async () => {
    const { client, state } = makeFakeClient();
    const s = await ShellSession.open("s4", fakeTarget(), client);
    await s.exec("cd /tmp");
    const before = state.calls.length;
    const r = await s.exec("echo '未闭合");
    expect(r.ok).toBe(false);
    expect(r.syntax_check).toBe("failed");
    expect(r.error).toContain("命令未执行");
    expect(state.calls.length).toBe(before); // 命令没有下发
    expect(r.cwd).toBe("/tmp"); // 会话状态未变
    s.close();
  });

  test("后台进程占住 fd：哨兵超时 + background_suspect + 重开会话", async () => {
    const { client } = makeFakeClient({ initialCwd: "/home/tester" });
    const s = await ShellSession.open("s5", fakeTarget(), client);
    await s.exec("cd /tmp");
    const r = await s.exec("#hang-forever", { timeoutMs: 250 });
    expect(r.timed_out).toBe(true);
    expect(r.background_suspect).toBe(true);
    expect(r.session_restarted).toBe(true);
    expect(r.error).toContain("未收到命令结束标记");
    // 重开后回到初始目录，且仍然可用
    const after = await s.exec("pwd");
    expect(after.stdout).toBe("/home/tester\n");
    s.close();
  });

  test("远端 shell 意外退出：不返回退出码，说明原因并重开", async () => {
    const { client } = makeFakeClient();
    const s = await ShellSession.open("s6", fakeTarget(), client);
    const r = await s.exec("#die");
    expect(r.exit_code).toBe(null);
    expect(r.session_restarted).toBe(true);
    const back = await s.exec("pwd");
    expect(back.exit_code).toBe(0);
    s.close();
  });

  test("超时也要带回超时前已产生的输出（不足一帧预留的字节不能被扣住）", async () => {
    const { client } = makeFakeClient();
    const s = await ShellSession.open("s8", fakeTarget(), client);
    const r = await s.exec("#hang BEFORE-OUT", { timeoutMs: 250 });
    expect(r.timed_out).toBe(true);
    // 回归点：drain() 末尾的 RESERVED 字节永不交付，短输出不 flush 就必然是空串（实测部署版就是空串）
    expect(r.stdout).toContain("BEFORE-OUT");
    expect(r.stdout_bytes).toBeGreaterThanOrEqual("BEFORE-OUT\n".length);
    // 桥只是停止等待：不能声称远端命令被终止（实测它会作为孤儿进程跑完）
    expect(r.error).toContain("不会终止远端命令");
    s.close();
  });

  test("通道结束（shell 退出）同样不丢已到达的输出", async () => {
    const { client } = makeFakeClient();
    const s = await ShellSession.open("s9", fakeTarget(), client);
    const r = await s.exec("#die AFTER-DIE");
    expect(r.exit_code).toBe(null);
    expect(r.stdout).toContain("AFTER-DIE");
    s.close();
  });

  test("输出预算：截断标记与真实总字节/行数", async () => {
    const { client } = makeFakeClient();
    const s = await ShellSession.open("s7", fakeTarget(), client);
    const body = "x".repeat(4000);
    const r = await s.exec(`echo ${body}`, { maxOutputBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.stdout_bytes).toBe(4001);
    expect(r.stdout_lines).toBe(1);
    expect(r.stdout.length).toBeLessThan(1500);
    expect(r.stdout).toContain("已截断");
    s.close();
  });

  test("没有 bash 时退化为 sh", async () => {
    const { client } = makeFakeClient({ noBash: true });
    const s = await ShellSession.open("s8", fakeTarget(), client);
    expect(s.shell).toBe("sh -s");
    s.close();
  });

  test("reset 语义：cwd 回到登录初始目录", async () => {
    const { client } = makeFakeClient({ initialCwd: "/home/tester" });
    const s = await ShellSession.open("s9", fakeTarget(), client);
    await s.exec("cd /var/log");
    expect(s.cwd).toBe("/var/log");
    await s.restart();
    expect(s.cwd).toBe("/home/tester");
    const r = await s.exec("pwd");
    expect(r.stdout).toBe("/home/tester\n");
    s.close();
  });
});

describe("SessionManager", () => {
  test("空闲超过 TTL 自动关闭，并在下次调用时报告原因", async () => {
    const { client } = makeFakeClient();
    const mgr = new SessionManager(40);
    const s = await mgr.create(fakeTarget(), client, { sessionId: "s-ttl" });
    expect(mgr.get("s-ttl")).toBe(s);

    await new Promise((r) => setTimeout(r, 120));
    const expired = mgr.sweep();
    expect(expired.map((e) => e.session_id)).toContain("s-ttl");
    expect(mgr.get("s-ttl")).toBeUndefined();
    const info = mgr.reapInfo("s-ttl");
    expect(info?.ttl_ms).toBe(40);
    expect(info && info.idle_ms >= 40).toBe(true);
    mgr.stop();
  });

  test("list 报告会话的 host/cwd/空闲时间", async () => {
    const { client } = makeFakeClient();
    const mgr = new SessionManager(60_000);
    await mgr.create(fakeTarget(), client, { sessionId: "s-list" });
    const rows = mgr.list();
    expect(rows.length).toBe(1);
    expect(rows[0]!.session_id).toBe("s-list");
    expect(rows[0]!.host).toBe("tester@127.0.0.1:22");
    mgr.close("s-list");
    expect(mgr.list().length).toBe(0);
    mgr.stop();
  });
});
