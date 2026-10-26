/**
 * MCP 协议层验收：真的用 stdio 启动 server，走真实握手与 tools/list。
 *
 * 这是契约第 1 条与第 2 条的证据：工具面齐全、未知主机报错会列出可用别名。
 * 子进程的环境变量指向临时配置，因此别名是确定的，也不碰真实 ~/.ssh。
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_DIR = join(import.meta.dir, "..");

const REQUIRED_TOOLS = [
  "ssh_hosts",
  "ssh_exec",
  "ssh_batch",
  "session_open",
  "session_exec",
  "session_reset",
  "session_close",
  "sftp_list",
  "sftp_stat",
  "sftp_read",
  "sftp_write",
  "sftp_mkdir",
  "sftp_put",
  "sftp_get",
];

/** 启动一次 server，跑一段检查，然后关掉进程并确认它真的退出。 */
async function withServer(run: (client: Client) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ssh-mcp-mcp-"));
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

  const client = new Client({ name: "ssh-mcp-test", version: "1.0.0" });
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

describe("MCP stdio server", () => {
  test("握手完成，tools/list 返回契约要求的全部工具", async () => {
      const meta = await withServer(async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      expect(names).toEqual([...REQUIRED_TOOLS].sort());
      // 每个工具都要有描述与入参 schema，模型才知道怎么调
      for (const tool of listed.tools) {
        expect(typeof tool.description === "string" && tool.description.length > 10).toBe(true);
        expect(tool.inputSchema).toBeObject();
        expect(tool.inputSchema.type).toBe("object");
        const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
        if (tool.name === "ssh_hosts") continue; // 唯一无入参的工具
        expect(Object.keys(props).length).toBeGreaterThan(0);
        // 其余工具要么直接指定 host，要么通过 session_id 复用已绑定主机的会话
        expect(props.host ?? props.session_id).toBeObject();
      }
      // 会话类工具必须暴露 session_id，否则无法连续使用
      const byName = new Map(listed.tools.map((t) => [t.name, t]));
      for (const name of ["session_exec", "session_reset", "session_close"]) {
        const props = byName.get(name)!.inputSchema!.properties as Record<string, unknown>;
        expect(props.session_id).toBeObject();
      }
    });
    expect(meta.exited).toBe(true);
  });

  test("ssh_hosts 读出 ssh_config 别名与本地 profile，不要求模型猜 IP", async () => {
    await withServer(async (client) => {
      const r = await client.callTool({ name: "ssh_hosts", arguments: {} });
      const p = r.structuredContent as any;
      expect(p.ok).toBe(true);
      const aliases = p.hosts.map((a: any) => a.name);
      expect(aliases).toContain("los");
      expect(aliases).toContain("demo");
      expect(aliases).toContain("profile_only");
      const los = p.hosts.find((a: any) => a.name === "los");
      expect(los.hostname).toBe("2607:f130:0:152::a048:e094");
      expect(los.user).toBe("root");
      expect(los.source).toContain("ssh_config");
      expect(typeof p.ssh_config_path).toBe("string");
      expect(r.isError).toBeFalsy();
    });
  });

  test("未知主机：返回错误并列出可用别名", async () => {
    await withServer(async (client) => {
      const r = await client.callTool({ name: "ssh_exec", arguments: { host: "not-exist", command: "pwd" } });
      expect(r.isError).toBe(true);
      const p = r.structuredContent as any;
      expect(p.error_type).toBe("unknown_host");
      expect(p.available_hosts).toContain("los");
      expect(p.available_hosts).toContain("profile_only");
      expect(String(p.hint)).toContain("ssh_hosts");
      // 错误也以可读文本返回，兼容只看 content 的客户端
      const text = (r.content as any[]).map((c) => c.text).join("");
      expect(text).toContain("not-exist");
      expect(text).toContain("los");
    });
  });

  test("入参不合法时给结构化错误，进程不死", async () => {
    await withServer(async (client) => {
      const bad = await client.callTool({ name: "ssh_exec", arguments: { host: "los" } });
      expect(bad.isError).toBe(true);
      const text = (bad.content as any[]).map((c) => c.text).join("");
      expect(text.toLowerCase()).toContain("command");
      // 还能继续调用 → server 没死
      const ok2 = await client.callTool({ name: "ssh_hosts", arguments: {} });
      expect((ok2.structuredContent as any).ok).toBe(true);
    });
  });
});
