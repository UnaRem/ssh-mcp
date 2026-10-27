/**
 * scripts/dist-verify.ts —— 单文件二进制产物的端到端验收
 *
 * 跑法：bun run dist-verify                        默认验 ~/tools/ssh-mcp.exe（完整，连远端）
 *       bun run dist-verify dist/ssh-mcp.exe       验刚构建出来的产物
 *       bun run dist-verify --offline              只跑协议层 6 项（CI 用：没有内网验收主机）
 *       SSH_MCP_DIST=<abs> bun run dist-verify
 *
 * 为什么单独一个脚本：`bun build --compile` 把依赖（含 ssh2 的原生模块）打进单文件，
 * 构建期不报错不代表运行期没问题——原生模块加载失败会退回 JS crypto（变慢但不错），
 * 而模块漏打则可能直接起不来。所以产物必须走一遍真实 stdio 握手 + tools/call。
 *
 * 它验的是「产物与源码行为一致」这一层，不替代 bun run live（后者 25 项，覆盖契约细节）。
 * 退出码：全部通过 0，任一失败 1。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PROJECT_DIR = path.join(import.meta.dir, "..");
const HOST = process.env.LIVE_HOST ?? "lan";
// 参数：<产物路径>（可选） --offline（只跑协议层，不连远端；给 CI 用）
const argv = process.argv.slice(2);
const OFFLINE = argv.includes("--offline");
const EXE =
  argv.find((a) => !a.startsWith("--")) ??
  process.env.SSH_MCP_DIST ??
  path.join(os.homedir(), "tools", process.platform === "win32" ? "ssh-mcp.exe" : "ssh-mcp");
const PKG_VERSION: string = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "package.json"), "utf8")).version;
const LOCAL_FILE = path.join(PROJECT_DIR, "package.json"); // 拿来当上传样本，内容稳定
const REMOTE_FILE = "/tmp/dist-verify.txt";

type Row = { name: string; ok: boolean; ms: number; note?: string; skip?: boolean };
const rows: Row[] = [];
async function check(name: string, fn: () => Promise<string | void> | string | void) {
  const t0 = Date.now();
  try {
    const note = await fn();
    rows.push({ name, ok: true, ms: Date.now() - t0, note: note ? String(note) : undefined });
  } catch (e) {
    rows.push({ name, ok: false, ms: Date.now() - t0, note: "FAIL: " + (e as Error).message });
  }
}

/**
 * 需要连远端的检查。CI 里没有内网验收主机，`--offline` 时记为 SKIP（不算失败也不算通过）。
 * 离线那六项（握手、身份与版本、工具面、自省、多余参数被拒、exe 同级配置发现）已经覆盖「依赖是否真的被打进产物」这一层。
 */
async function checkRemote(name: string, fn: () => Promise<string | void> | string | void) {
  if (OFFLINE) {
    rows.push({ name, ok: true, ms: 0, skip: true, note: "SKIP（--offline，不连远端）" });
    return;
  }
  await check(name, fn);
}

async function startServer() {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? os.homedir(),
    USERPROFILE: process.env.USERPROFILE ?? os.homedir(),
  };
  const cfg = path.join(PROJECT_DIR, "config.local.json");
  if (fs.existsSync(cfg)) env.SSH_MCP_CONFIG = cfg; // 产物不依赖 cwd，配置一律显式给
  const transport = new StdioClientTransport({ command: EXE, args: [], cwd: PROJECT_DIR, stderr: "pipe", env });
  const stderr: string[] = [];
  transport.stderr?.on("data", (c: Buffer) => stderr.push(c.toString()));
  const client = new Client({ name: "dist-verify", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr.join(""), close: () => client.close().catch(() => {}) };
}

function textOf(r: any): string {
  return ((r.content as any[] | undefined) ?? []).map((c) => c.text ?? "").join("\n");
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return { r, p: (r.structuredContent ?? {}) as any, isError: !!r.isError, text: textOf(r) };
}

async function call2(client: Client, name: string, args: Record<string, unknown>) {
  const c = await call(client, name, args);
  if (c.isError) throw new Error(`${name} 返回工具错误：${c.text.slice(0, 400)}`);
  return c.p;
}

async function main() {
  assert.ok(fs.existsSync(EXE), `找不到产物：${EXE}（先 bun run build，或把路径传进来）`);
  const sizeMiB = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
  console.log(`验收产物：${EXE}（${sizeMiB} MiB）模式：${OFFLINE ? "离线（只跑协议层）" : "完整（连远端 " + HOST + "）"}`);

  const t0 = Date.now();
  const srv = await startServer();
  try {
    const banner = srv.stderr().trim().split("\n")[0] ?? "";
    await check("产物能启动并完成 stdio 握手", () => {
      assert.ok(srv.client.getServerVersion(), "没有 serverInfo");
      return `握手 ${Date.now() - t0}ms；stderr 首行：${banner}`;
    });

    await check("身份名与 version 未被构建改写", () => {
      const v = srv.client.getServerVersion()!;
      assert.equal(v.name, "ssh");
      assert.equal(v.version, PKG_VERSION, `version 与 package.json(${PKG_VERSION}) 不一致：版本号只能有一个来源`);
      return `name=${v.name} version=${v.version}（与 package.json 一致）`;
    });

    await check("tools/list 恰好 ssh_run / ssh_file", async () => {
      const tools = (await srv.client.listTools()).tools;
      assert.deepEqual(tools.map((t) => t.name).sort(), ["ssh_file", "ssh_run"]);
      for (const t of tools) {
        assert.equal((t.inputSchema as any).additionalProperties, false, `${t.name} 少了 additionalProperties:false`);
      }
      return `两个工具的 schema 与源码版一致`;
    });

    await check("自省模式返回主机清单", async () => {
      const p = await call2(srv.client, "ssh_run", {});
      assert.equal(p.mode, "inventory");
      const haveCfg = fs.existsSync(path.join(PROJECT_DIR, "config.local.json"));
      if (haveCfg) {
        assert.ok((p.hosts ?? []).length >= 1, "有 config.local.json 却没返回主机");
        assert.equal(p.local_config_exists, true, "config.local.json 没读到（产物不依赖 cwd）");
        return `hosts=${p.hosts.map((h: any) => h.name).join(",")} config=${p.local_config_path}`;
      }
      // CI 里没有本地 profile：应当如实报告读不到，并把来源说清（这不是失败）
      assert.ok(Array.isArray(p.hosts), "hosts 应当是数组");
      assert.equal(p.local_config_exists, false);
      return `无本地 profile：local_config_exists=false，从 ${p.ssh_config_path} 读到 ${p.hosts.length} 个别名`;
    });

    await checkRemote("真实执行：新建连接并返回内核", async () => {
      const t = Date.now();
      const p = await call2(srv.client, "ssh_run", { host: HOST, command: "uname -sr" });
      assert.equal(p.exit_code, 0);
      assert.match(String(p.stdout), /Linux/);
      assert.equal(p.host_key.status, "match", "host key 应当复用既有条目");
      // 建连耗时是原生模块的观测点：真退回 JS crypto 会明显变慢（数量级判断，不作硬阈值）
      return `建连+执行 ${Date.now() - t}ms，服务端内部 ${p.duration_ms}ms，auth=${p.auth_succeeded_with}`;
    });

    await checkRemote("连接池在产物里生效（第二次调用不建新连）", async () => {
      const p = await call2(srv.client, "ssh_run", { host: HOST, command: "true" });
      assert.equal(p.connection, "reused");
      return `connection=reused ${p.duration_ms}ms`;
    });

    await checkRemote("命令失败仍是数据不是工具错误", async () => {
      const c = await call(srv.client, "ssh_run", { host: HOST, command: "sh -c 'exit 7'" });
      assert.equal(c.isError, false);
      assert.equal(c.p.ok, false);
      assert.equal(c.p.exit_code, 7);
      return "exit_code=7 顶层 ok=false";
    });

    await checkRemote("连续会话：跨调用保持 cwd，close 干净", async () => {
      const s1 = await call2(srv.client, "ssh_run", { host: HOST, session: "keep", command: "cd /tmp && pwd" });
      const s2 = await call2(srv.client, "ssh_run", { session: "keep", command: "pwd" });
      assert.equal(s2.session_id, s1.session_id);
      assert.equal(s2.cwd, "/tmp");
      const c = await call2(srv.client, "ssh_run", { session: "keep", session_op: "close" });
      assert.deepEqual(c.remaining, []);
      return `cwd=/tmp 已保持，closed=${JSON.stringify(c.closed)}`;
    });

    await checkRemote("ssh_file put/get 与本地 sha256 一致", async () => {
      const tmpLocal = path.join(os.tmpdir(), `dist-verify-back-${process.pid}.json`);
      const r = await call2(srv.client, "ssh_file", {
        host: HOST,
        entries: [
          { op: "put", remote_path: REMOTE_FILE, local_path: LOCAL_FILE },
          { op: "get", remote_path: REMOTE_FILE, local_path: tmpLocal },
        ],
      });
      const [put, get] = r.entries;
      assert.equal(put.ok, true, put.error);
      assert.equal(get.ok, true, get.error);
      const local = createHash("sha256").update(fs.readFileSync(LOCAL_FILE)).digest("hex");
      assert.equal(put.sha256_local, local);
      assert.equal(get.sha256_local, local);
      fs.rmSync(tmpLocal, { force: true });
      return `bytes=${put.remote_bytes} sha256=${local.slice(0, 12)}…`;
    });

    await check("多余参数被 schema 挡住（additionalProperties 生效）", async () => {
      const c = await call(srv.client, "ssh_run", { host: HOST, command: "true", user: "x" });
      assert.equal(c.isError, true);
      assert.match(c.text, /user/);
      return c.text.slice(0, 90);
    });

    await check("exe 同级的 config.local.json 自动生效（不设 SSH_MCP_CONFIG、cwd 无配置）", async () => {
      const dirCfg = fs.mkdtempSync(path.join(os.tmpdir(), "dist-cfg-"));
      const dirCwd = fs.mkdtempSync(path.join(os.tmpdir(), "dist-cwd-"));
      let client: Client | undefined;
      try {
        const exeCopy = path.join(dirCfg, path.basename(EXE));
        fs.copyFileSync(EXE, exeCopy);
        const cfgHere = path.join(dirCfg, "config.local.json");
        fs.writeFileSync(cfgHere, JSON.stringify({ hosts: { probehost: { hostname: "192.0.2.7", user: "u" } } }));
        // 全新实例：不设 SSH_MCP_CONFIG，cwd 是空目录——只有「exe 同级」这条候选能命中
        const transport = new StdioClientTransport({
          command: exeCopy,
          args: [],
          cwd: dirCwd,
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? os.homedir(),
            USERPROFILE: process.env.USERPROFILE ?? os.homedir(),
          },
        });
        client = new Client({ name: "dist-verify-cfg", version: "1.0.0" });
        await client.connect(transport);
        const p = await call2(client, "ssh_run", {});
        assert.equal(p.local_config_exists, true, "exe 同级的配置没被发现");
        assert.equal(path.normalize(p.local_config_path), path.normalize(cfgHere), "发现的路径不是 exe 同级那份");
        assert.ok((p.hosts ?? []).some((h: any) => h.name === "probehost"), "发现的配置没供给 hosts 清单");
        return `local_config_path=${p.local_config_path}`;
      } finally {
        await client?.close().catch(() => {});
        fs.rmSync(dirCfg, { recursive: true, force: true });
        fs.rmSync(dirCwd, { recursive: true, force: true });
      }
    });

    await checkRemote("清理远端临时文件", async () => {
      const p = await call2(srv.client, "ssh_run", { host: HOST, command: `rm -f ${REMOTE_FILE} && echo 已清理` });
      return String(p.stdout).trim();
    });
  } finally {
    await srv.close();
  }

  console.log("\n==== 产物验收结果 ====");
  let failed = 0;
  let skipped = 0;
  for (const r of rows) {
    if (!r.ok) failed++;
    if (r.skip) skipped++;
    const tag = r.skip ? "SKIP" : r.ok ? "PASS" : "FAIL";
    console.log(`${tag}  ${r.name}${r.skip ? "" : `  (${r.ms}ms)`}`);
    if (r.note) console.log(`      ${r.note}`);
  }
  const ran = rows.length - skipped;
  console.log(`\n合计 ${ran} 项，失败 ${failed} 项${skipped ? `，跳过 ${skipped} 项（--offline）` : ""}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("dist-verify 自身出错：", e);
  process.exit(2);
});
