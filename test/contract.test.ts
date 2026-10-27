/**
 * 对外契约测试：工具面只有两个工具，是一层「SSH 桥」。
 *
 * 设计原则（唯一判据）：桥只补 shell 给不了的东西 ——
 *   认证与主机密钥校验、连接复用、退出码与 stdout/stderr 分离、输出预算与总量回报、跨调用的会话状态。
 * 其余一律透传原生 Linux 命令：多步用 &&、取尾部用 tail、区间用 sed、写文件用 heredoc、建目录用 mkdir -p。
 * 因此这里的断言有两类：
 *   1) 契约必须窄（属性集合恰好等于声明的集合，实现细节不得泄漏成参数）；
 *   2) 契约必须可判定（错误带 error_code，未知主机回可用清单，未知参数回允许字段列表）。
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_DIR = join(import.meta.dir, "..");
const PKG_VERSION: string = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf8")).version;

/** 两个工具就是全部对外面。多一个即契约漂移。 */
const REQUIRED_TOOLS = ["ssh_run", "ssh_file"];

/** 每个工具声明的属性集合。实现细节（keep_stdin、连接参数）不允许出现在这里。 */
const RUN_PROPS = ["host", "command", "session", "session_op", "cwd", "env", "timeout_ms", "max_output_bytes"];
const RUN_FORBIDDEN = ["user", "port", "host_key_policy", "keep_stdin", "commands", "stop_on_error", "max_steps", "output_mode", "session_id"];
const FILE_ENTRY_PROPS = ["op", "remote_path", "local_path", "overwrite"];
const FILE_FORBIDDEN = ["user", "port", "host_key_policy", "content", "append", "mode", "recursive", "max_bytes"];

/** 启动一次 server，跑一段检查，然后关掉进程并确认它真的退出（不留常驻进程）。 */
async function withServer(run: (client: Client) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-contract-"));
  const sshCfg = join(dir, "ssh_config");
  writeFileSync(
    sshCfg,
    [
      "Host los",
      "  HostName 2607:f130:0:152::a048:e094",
      "  User root",
      "  Port 22",
      "  IdentityFile " + join(dir, "no-key"),
      "",
      "Host demo",
      "  HostName 127.0.0.1",
      "  User demo",
      "",
    ].join("\n"),
  );
  const localCfg = join(dir, "config.local.json");
  writeFileSync(localCfg, JSON.stringify({ hosts: { profile_only: { hostname: "10.0.0.9", user: "u" } } }, null, 2));

  const transport = new StdioClientTransport({
    command: process.execPath, // 用当前 bun 可执行文件启动，避免依赖 PATH
    args: ["run", "src/index.ts"],
    cwd: PROJECT_DIR,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? dir,
      USERPROFILE: process.env.USERPROFILE ?? dir,
      SSH_MCP_SSH_CONFIG: sshCfg,
      SSH_MCP_CONFIG: localCfg,
      SSH_MCP_KNOWN_HOSTS: join(dir, "known_hosts"),
      SSH_MCP_READY_TIMEOUT_MS: "2000",
    },
  });
  const stderrChunks: string[] = [];
  transport.stderr?.on("data", (c: Buffer) => stderrChunks.push(c.toString()));

  const client = new Client({ name: "ssh-mcp-contract", version: "1.0.0" });
  let childPid: number | null = null;
  let exited = false;
  try {
    await client.connect(transport);
    childPid = transport.pid; // connect 之后进程才存在，pid 只能在这里取
    await run(client);
  } finally {
    await client.close().catch(() => {});
    // 契约边界：除 MCP server 自身外不启动常驻进程，客户端关闭后不应有残留
    if (childPid) exited = await waitUntilGone(childPid);
    rmSync(dir, { recursive: true, force: true });
  }
  return { exited, stderr: stderrChunks.join("") };
}

/** 轮询等子进程消失；已退出时 process.kill(pid, 0) 会抛 ESRCH */
async function waitUntilGone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(50);
    } catch {
      return true;
    }
  }
  return false;
}

/** 取 structuredContent，断言它存在 */
function payloadOf(r: unknown): Record<string, any> {
  const p = (r as { structuredContent?: unknown }).structuredContent;
  expect(p).toBeObject();
  return p as Record<string, any>;
}

const textOf = (r: unknown): string =>
  (((r as { content?: unknown[] }).content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("");

describe("对外契约：只有两个工具", () => {
  test("tools/list 恰好是 ssh_run 与 ssh_file，且都带 ASCII 检索关键词", async () => {
    const meta = await withServer(async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual([...REQUIRED_TOOLS].sort());
      for (const tool of listed.tools) {
        expect(typeof tool.description === "string" && tool.description.length > 10).toBe(true);
        // 客户端的检索只认 ASCII：没有 Keywords 就等于找不到工具
        expect(String(tool.description)).toContain("Keywords:");
        expect(tool.inputSchema).toBeObject();
        expect(tool.inputSchema.type).toBe("object");
      }
      // server 身份名决定 PI-Desktop 的 mcp_ 前缀；带 -mcp_ 会与工具名的 ssh_ 段交错重复，模型实测写错
      expect(client.getServerVersion()?.name).toBe("ssh");
      // 版本单一来源：只有 package.json 里有版本号。tag 驱动发布时不许两处漂移。
      expect(client.getServerVersion()?.version).toBe(PKG_VERSION);
    });
    expect(meta.exited).toBe(true);
  });

  test("ssh_run 的属性集合恰好等于声明值，实现细节不泄漏成参数", async () => {
    await withServer(async (client) => {
      const listed = await client.listTools();
      const run = listed.tools.find((t) => t.name === "ssh_run")!;
      const props = Object.keys((run.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort();
      expect(props).toEqual([...RUN_PROPS].sort());
      for (const banned of RUN_FORBIDDEN) {
        expect(props).not.toContain(banned);
      }
      // 每个参数都要自带文档：默认值与用法写在 schema 里，模型才不用猜
      const schemaProps = (run.inputSchema as unknown as { properties: Record<string, { description?: string }> }).properties;
      for (const key of RUN_PROPS) {
        expect(String(schemaProps[key]?.description ?? "").length).toBeGreaterThan(10);
      }
      expect(String(schemaProps["host"]?.description)).toContain("ssh config");
      expect(String(schemaProps["session"]?.description)).toContain("keep");
    });
  });

  test("ssh_file 只有 put/get 两种传输，属性同样窄", async () => {
    await withServer(async (client) => {
      const listed = await client.listTools();
      const file = listed.tools.find((t) => t.name === "ssh_file")!;
      const props = Object.keys((file.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort();
      expect(props).toEqual(["entries", "host"]);
      const entry = (
        file.inputSchema as unknown as {
          properties: { entries: { items: { properties?: Record<string, unknown>; required?: string[] } } };
        }
      ).properties;
      const entryProps = Object.keys(entry.entries.items.properties ?? {}).sort();
      expect(entryProps).toEqual([...FILE_ENTRY_PROPS].sort());
      for (const banned of FILE_FORBIDDEN) expect(entryProps).not.toContain(banned);
      expect([...(entry.entries.items.required ?? [])].sort()).toEqual(["local_path", "op", "remote_path"]);
    });
  });
});

describe("对外契约：可判定的失败", () => {
  test("不传任何参数 = 自省：回可用主机清单与活动连接/会话", async () => {
    await withServer(async (client) => {
      const r = await client.callTool({ name: "ssh_run", arguments: {} });
      const p = payloadOf(r);
      expect(p.ok).toBe(true);
      const names = (p.hosts as { name: string }[]).map((h) => h.name);
      expect(names).toContain("los");
      expect(names).toContain("demo");
      expect(names).toContain("profile_only");
      expect(typeof p.ssh_config_path).toBe("string");
      expect(p.active_sessions).toBeArray();
      expect(r.isError).toBeFalsy();
    });
  });

  test("未知主机：error_code=unknown_host 并回可用别名，文本里也能读到", async () => {
    await withServer(async (client) => {
      const r = await client.callTool({ name: "ssh_run", arguments: { host: "not-exist", command: "pwd" } });
      expect(r.isError).toBe(true);
      const p = payloadOf(r);
      expect(p.error_code).toBe("unknown_host");
      expect(p.available_hosts).toContain("los");
      expect(p.available_hosts).toContain("profile_only");
      const text = textOf(r);
      expect(text).toContain("not-exist");
      expect(text).toContain("los");
    });
  });

  test("缺 command：error_code=bad_input，并说明该传什么", async () => {
    await withServer(async (client) => {
      const r = await client.callTool({ name: "ssh_run", arguments: { host: "los" } });
      expect(r.isError).toBe(true);
      expect(payloadOf(r).error_code).toBe("bad_input");
      expect(textOf(r).toLowerCase()).toContain("command");
      // 还能继续调用 → server 没死
      const ok2 = await client.callTool({ name: "ssh_run", arguments: {} });
      expect(payloadOf(ok2).ok).toBe(true);
    });
  });

  test("未知参数：不静默丢弃，直接被拒并点出写错的键", async () => {
    await withServer(async (client) => {
      const listed = await client.listTools();
      const run = listed.tools.find((t) => t.name === "ssh_run")!;
      // 发布的 schema 自己就说明「只接受这些」，模型写错时也能自己看到
      expect((run.inputSchema as unknown as { additionalProperties?: unknown }).additionalProperties).toBe(false);
      const r = await client.callTool({
        name: "ssh_run",
        arguments: { host: "los", command: "pwd", user: "root", timeout: 123 },
      });
      expect(r.isError).toBe(true);
      const text = textOf(r);
      expect(text).toContain("user");
      expect(text).toContain("timeout");
      // 被拒之后 server 仍可用
      const ok2 = await client.callTool({ name: "ssh_run", arguments: {} });
      expect(payloadOf(ok2).ok).toBe(true);
    });
  });

  test("ssh_file 的 op 只接受 put/get，其它文件操作要走原生命令", async () => {
    await withServer(async (client) => {
      const r = await client.callTool({
        name: "ssh_file",
        arguments: { host: "los", entries: [{ op: "list", remote_path: "/tmp", local_path: "/tmp/x" }] },
      });
      expect(r.isError).toBe(true);
      expect(payloadOf(r).error_code).toBe("bad_input");
      expect(textOf(r).toLowerCase()).toContain("put");
    });
  });

  test('session="keep" 但没有 host 也没有活动会话：error_code=no_session（会话不存在只有一种错误码）', async () => {
    await withServer(async (client) => {
      const r = await client.callTool({ name: "ssh_run", arguments: { session: "keep", command: "pwd" } });
      expect(r.isError).toBe(true);
      const p = payloadOf(r);
      expect(p.error_code).toBe("no_session");
      expect(p.active_sessions).toBeArray();
      expect(textOf(r)).toContain("host");
    });
  });

  test("会话 id 不存在：error_code=no_session，并给出当前活动会话", async () => {
    await withServer(async (client) => {
      const r = await client.callTool({ name: "ssh_run", arguments: { session: "s_nope", command: "pwd" } });
      expect(r.isError).toBe(true);
      const p = payloadOf(r);
      expect(p.error_code).toBe("no_session");
      expect(p.active_sessions).toBeArray();
    });
  });
});
