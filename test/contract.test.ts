/**
 * 对外契约测试：工具面只有两个工具，是一层「SSH 桥」。
 *
 * 设计原则（唯一判据）：桥只补 shell 给不了的东西 ——
 *   认证与主机密钥校验、连接复用、退出码与 stdout/stderr 分离、输出预算与总量回报、跨调用的会话状态。
 * 其余一律透传原生 Linux 命令：多步用 &&、取尾部用 tail、区间用 sed、写文件用 heredoc、建目录用 mkdir -p。
 * 因此这里的断言有三类：
 *   1) 契约必须窄（属性集合恰好等于声明的集合，实现细节不得泄漏成参数）；
 *   2) 契约必须可判定（错误带 error_code，未知主机回可用清单，未知参数回允许字段列表）；
 *   3) 工具面必须「薄」：description 只说判定所需的事实，案例/反例/写法教学在
 *      skills/ssh-mcp/SKILL.md（随安装同步给 agent），两处名字必须一致——本文件最后一段锁这个。
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_TIMEOUT_MS } from "../src/tool.ts";

const PROJECT_DIR = join(import.meta.dir, "..");
const PKG_VERSION: string = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf8")).version;

/** 两个工具就是全部对外面。多一个即契约漂移。
 *  名字不带 ssh_ 前缀：server 身份名 "ssh" 已经提供命名空间（PI-Desktop 可见名 mcp_ssh_<tool>），
 *  原名 ssh_run/ssh_file 会拼出 mcp_ssh_ssh_run 这种重复段；改名记录见 AGENTS.md。 */
const REQUIRED_TOOLS = ["exec", "transfer"];

/** 每个工具声明的属性集合。实现细节（keep_stdin、连接参数）不允许出现在这里。 */
const RUN_PROPS = ["host", "command", "session", "session_op", "cwd", "env", "timeout_ms", "max_output_bytes"];
const RUN_FORBIDDEN = ["user", "port", "host_key_policy", "keep_stdin", "commands", "stop_on_error", "max_steps", "output_mode", "session_id"];
const FILE_ENTRY_PROPS = ["op", "remote_path", "local_path", "overwrite"];
const FILE_FORBIDDEN = ["user", "port", "host_key_policy", "content", "append", "mode", "recursive", "max_bytes"];

/** 薄描述的上限：description 只承载「判定 + 边界 + 检索关键词」，教学在 SKILL。
 *  超过这个长度就是在往描述里塞案例与写法，说明有人在绕过 SKILL 这条线。 */
const MAX_DESCRIPTION_CHARS = 800;

/** 启动一次 server，跑一段检查，然后关掉进程并确认它真的退出（不留常驻进程）。
 *  localConfigContent: null → 活动路径上不预写文件（用于「首启生成模板」路径）。 */
async function withServer(
  run: (client: Client, paths: { dir: string; localCfg: string }) => Promise<void>,
  opts?: { localConfigContent?: string | null },
) {
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
  if (opts?.localConfigContent !== null) {
    writeFileSync(localCfg, opts?.localConfigContent ?? JSON.stringify({ hosts: { profile_only: { hostname: "10.0.0.9", user: "u" } } }, null, 2));
  }

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
    await run(client, { dir, localCfg });
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
  test("tools/list 恰好是 exec 与 transfer，且都带 ASCII 检索关键词", async () => {
    const meta = await withServer(async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual([...REQUIRED_TOOLS].sort());
      for (const tool of listed.tools) {
        expect(typeof tool.description === "string" && tool.description.length > 10).toBe(true);
        // 客户端的检索只认 ASCII：没有 Keywords 就等于找不到工具
        expect(String(tool.description)).toContain("Keywords:");
        // 薄描述：案例与写法教学在 SKILL，不在这里
        expect(String(tool.description).length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
        expect(tool.inputSchema).toBeObject();
        expect(tool.inputSchema.type).toBe("object");
      }
      // server 身份名决定 PI-Desktop 的 mcp_ 前缀；工具名不再带 ssh_ 段，拼出的是 mcp_ssh_exec / mcp_ssh_transfer
      expect(client.getServerVersion()?.name).toBe("ssh");
      // 版本单一来源：只有 package.json 里有版本号。tag 驱动发布时不许两处漂移。
      expect(client.getServerVersion()?.version).toBe(PKG_VERSION);
    });
    expect(meta.exited).toBe(true);
  });

  test("exec 的属性集合恰好等于声明值，实现细节不泄漏成参数", async () => {
    await withServer(async (client) => {
      const listed = await client.listTools();
      const run = listed.tools.find((t) => t.name === "exec")!;
      const props = Object.keys((run.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort();
      expect(props).toEqual([...RUN_PROPS].sort());
      for (const banned of RUN_FORBIDDEN) {
        expect(props).not.toContain(banned);
      }
      // 每个参数都要自带文档：契约（默认值、边界）写在 schema 里，用法教学在 SKILL
      const schemaProps = (run.inputSchema as unknown as { properties: Record<string, { description?: string }> }).properties;
      for (const key of RUN_PROPS) {
        expect(String(schemaProps[key]?.description ?? "").length).toBeGreaterThan(10);
      }
      expect(String(schemaProps["host"]?.description)).toContain("ssh config");
      expect(String(schemaProps["session"]?.description)).toContain("keep");
      // 超时的上限就是默认值。发布的 schema 不带上限：超出只截不拒（由 SDK 拒绝的话
      // 没有 structuredContent，命令也不会执行），截断这件事由结果里的 timeout_capped 说明。
      // 注：zod 的 .int() 会自带 2^53-1 这个 maximum，所以断言的是「不等于我们的上限」。
      const timeoutProp = schemaProps["timeout_ms"] as unknown as { maximum?: number; description?: string };
      expect(timeoutProp.maximum).not.toBe(MAX_TIMEOUT_MS);
      expect(Number(timeoutProp.maximum)).toBeGreaterThan(MAX_TIMEOUT_MS);
      expect(String(timeoutProp.description)).toContain("timeout_capped");
      // 旧名不能出现在对外任何一处：客户端与 SKILL 引用的都是新名
      expect(String(run.description)).not.toContain("ssh_run");
    });
  });

  test("transfer 只有 put/get 两种传输，属性同样窄", async () => {
    await withServer(async (client) => {
      const listed = await client.listTools();
      const file = listed.tools.find((t) => t.name === "transfer")!;
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
      expect(String(file.description)).not.toContain("ssh_file");
    });
  });
});

describe("对外契约：可判定的失败", () => {
  test("不传任何参数 = 自省：回可用主机清单与活动连接/会话", async () => {
    await withServer(async (client) => {
      const r = await client.callTool({ name: "exec", arguments: {} });
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

  test("活动配置路径不存在：启动时生成模板（只创建、不覆盖，TOFU 同款语义）", async () => {
    await withServer(
      async (client, paths) => {
        // server 启动后发现活动路径上没有文件，就在这里建模板——新机器零拷贝可用
        const raw = JSON.parse(readFileSync(paths.localCfg, "utf8"));
        expect(raw.hosts.example).toBeObject();
        // 占位地址用 RFC5737 TEST-NET，不会与真实主机撞；格式要素齐可见
        expect(String(raw.hosts.example.hostname)).toMatch(/^192\.0\.2\./);
        expect(raw.defaults.host_key_policy).toBe("tofu");
        // 模板即「存在」：自省报告指向它，别名清单含 example（用户照着改/删）
        const r = await client.callTool({ name: "exec", arguments: {} });
        const p = payloadOf(r);
        expect(p.local_config_exists).toBe(true);
        expect(p.local_config_path).toBe(paths.localCfg);
        expect((p.hosts as { name: string }[]).map((h) => h.name)).toContain("example");
      },
      { localConfigContent: null },
    );
  });

  test("未知主机：error_code=unknown_host 并回可用别名，文本里也能读到", async () => {
    await withServer(async (client) => {
      const r = await client.callTool({ name: "exec", arguments: { host: "not-exist", command: "pwd" } });
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
      const r = await client.callTool({ name: "exec", arguments: { host: "los" } });
      expect(r.isError).toBe(true);
      expect(payloadOf(r).error_code).toBe("bad_input");
      expect(textOf(r).toLowerCase()).toContain("command");
      // 还能继续调用 → server 没死
      const ok2 = await client.callTool({ name: "exec", arguments: {} });
      expect(payloadOf(ok2).ok).toBe(true);
    });
  });

  test("未知参数：不静默丢弃，直接被拒并点出写错的键", async () => {
    await withServer(async (client) => {
      const listed = await client.listTools();
      const run = listed.tools.find((t) => t.name === "exec")!;
      // 发布的 schema 自己就说明「只接受这些」，模型写错时也能自己看到
      expect((run.inputSchema as unknown as { additionalProperties?: unknown }).additionalProperties).toBe(false);
      const r = await client.callTool({
        name: "exec",
        arguments: { host: "los", command: "pwd", user: "root", timeout: 123 },
      });
      expect(r.isError).toBe(true);
      const text = textOf(r);
      expect(text).toContain("user");
      expect(text).toContain("timeout");
      // 被拒之后 server 仍可用
      const ok2 = await client.callTool({ name: "exec", arguments: {} });
      expect(payloadOf(ok2).ok).toBe(true);
    });
  });

  test("transfer 的 op 只接受 put/get，其它文件操作要走原生命令", async () => {
    await withServer(async (client) => {
      const r = await client.callTool({
        name: "transfer",
        arguments: { host: "los", entries: [{ op: "list", remote_path: "/tmp", local_path: "/tmp/x" }] },
      });
      expect(r.isError).toBe(true);
      expect(payloadOf(r).error_code).toBe("bad_input");
      expect(textOf(r).toLowerCase()).toContain("put");
    });
  });

  test('session="keep" 但没有 host 也没有活动会话：error_code=no_session（会话不存在只有一种错误码）', async () => {
    await withServer(async (client) => {
      const r = await client.callTool({ name: "exec", arguments: { session: "keep", command: "pwd" } });
      expect(r.isError).toBe(true);
      const p = payloadOf(r);
      expect(p.error_code).toBe("no_session");
      expect(p.active_sessions).toBeArray();
      expect(textOf(r)).toContain("host");
    });
  });

  test("会话 id 不存在：error_code=no_session，并给出当前活动会话", async () => {
    await withServer(async (client) => {
      const r = await client.callTool({ name: "exec", arguments: { session: "s_nope", command: "pwd" } });
      expect(r.isError).toBe(true);
      const p = payloadOf(r);
      expect(p.error_code).toBe("no_session");
      expect(p.active_sessions).toBeArray();
    });
  });
});

describe("对外契约：SKILL 与工具名同步（随安装注入的使用面）", () => {
  const skillPath = join(PROJECT_DIR, "skills", "ssh-mcp", "SKILL.md");

  test("skills/ssh-mcp/SKILL.md 存在，frontmatter 合规（name + 够长的触发描述）", () => {
    expect(existsSync(skillPath)).toBe(true);
    const text = readFileSync(skillPath, "utf8");
    expect(text).toMatch(/^---\nname: ssh-mcp\n/);
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    expect(m).toBeObject();
    const desc = m?.[1]?.match(/^description: (.+)$/m)?.[1];
    // 描述要足以让 agent 主动用：说清「何时用」，太短等于目录里没这条
    expect(desc ?? "").toBeString();
    expect((desc ?? "").length).toBeGreaterThan(60);
    expect(desc ?? "").toContain("远端");
  });

  test("SKILL 引用的工具名与注册名一致，正反例要素齐全", () => {
    const text = readFileSync(skillPath, "utf8");
    for (const name of REQUIRED_TOOLS) {
      // 正文用反引号包名：agent 读到的就是这个形状，名字漂移会直接让 SKILL 指错工具
      expect(text).toContain("`" + name + "`");
    }
    // 旧名不许再出现在任何对外文本里（客户端登记、SKILL、描述都只认新名）
    expect(text).not.toContain("ssh_run");
    expect(text).not.toContain("ssh_file");
    // 正反例是本 SKILL 的骨架：没有它们就退回「agent 有工具却不用」的老问题
    expect(text).toContain("正例");
    expect(text).toContain("反例");
    // 关键反例/正例的锚点：sleep 等待、起后台轮询、起会话保持状态、只读文件走原生命令
    for (const needle of ["sleep", "nohup", "tail -n", "keep", "ls"]) {
      expect(text).toContain(needle);
    }
  });
});
