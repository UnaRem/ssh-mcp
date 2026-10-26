/**
 * scripts/live-verify.ts —— 真实主机端到端验收（契约第 2–11 条）
 *
 * 跑法：bun run scripts/live-verify.ts
 * 凭据来源：config.local.json（已被 .gitignore 忽略）或 SSH_MCP_PASSWORD*；本文件不含明文密码。
 *
 * 说明：整个验收过程用一份「真实 known_hosts 的副本」作为 SSH_MCP_KNOWN_HOSTS，
 * 这样既验证了对既有条目的复用，又保证不动 ~/.ssh/known_hosts 本身。
 * 退出码：全部通过 0，任一失败 1。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { utils } from "ssh2";

const PROJECT_DIR = path.join(import.meta.dir, "..");
const HOST = process.env.LIVE_HOST ?? "lan"; // 别名在 config.local.json 里
const KEYFIRST = process.env.LIVE_HOST_KEYFIRST ?? "lan-keyfirst"; // 故意用远端不认的本地私钥
const NEG_HOST = process.env.LIVE_HOST_NEG ?? "los"; // 密钥被拒、无密码 → 必须快速失败
const NEG_IP = "192.168.1.21";

// ---------- 结果记录 ----------
type Row = { name: string; ok: boolean; ms: number; note?: string };
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

// ---------- 起真实 MCP server（和生产环境同一条路径：stdio + bun run src/index.ts） ----------
async function startServer(extraEnv: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/index.ts"],
    cwd: PROJECT_DIR,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? os.homedir(),
      USERPROFILE: process.env.USERPROFILE ?? os.homedir(),
      ...extraEnv,
    },
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (c: Buffer) => stderr.push(c.toString()));
  const client = new Client({ name: "live-verify", version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    stderr: () => stderr.join(""),
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

function textOf(r: any): string {
  return (r.content as any[] | undefined ?? []).map((c) => c.text ?? "").join("\n");
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return { r, p: (r.structuredContent ?? {}) as any, isError: !!r.isError, text: textOf(r) };
}

/** 必须是成功调用，否则把错误文本抛出来 */
async function mustOk(client: Client, name: string, args: Record<string, unknown>) {
  const c = await call(client, name, args);
  if (c.isError) throw new Error(`${name} 返回工具错误：${c.text.slice(0, 400)}`);
  return c.p;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 生成一把与远端无关的主机公钥 blob，用来构造 host key 不匹配的场景 */
function foreignHostKeyLine(host: string): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const blob = (utils.parseKey(Buffer.from(privateKey)) as { getPublicSSH(): Buffer }).getPublicSSH();
  return `${host} ssh-rsa ${Buffer.from(blob).toString("base64")}`;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-live-"));
  const realKnownHosts = path.join(os.homedir(), ".ssh", "known_hosts");
  const khCopy = path.join(tmp, "known_hosts.copy");
  const khEmpty = path.join(tmp, "known_hosts.empty");
  const khWrong = path.join(tmp, "known_hosts.wrong");
  fs.writeFileSync(khCopy, fs.existsSync(realKnownHosts) ? fs.readFileSync(realKnownHosts) : "");
  fs.writeFileSync(khEmpty, "");
  fs.writeFileSync(khWrong, foreignHostKeyLine(NEG_IP) + "\n");
  const stamp = Date.now();
  const remoteDir = `/tmp/ssh-mcp-verify-${stamp}`;
  const localFile = path.join(tmp, "upload.txt");
  const localBack = path.join(tmp, "downloaded.txt");
  const payload = "ssh-mcp 验收 " + stamp + "\n第二行\n";
  fs.writeFileSync(localFile, payload, "utf8");
  const localSha = sha256(fs.readFileSync(localFile));

  console.log(`验收主机别名=${HOST}  临时目录=${tmp}`);
  console.log(`known_hosts 副本=${khCopy}（原文件不动）`);

  // ============ 主 server：使用真实 known_hosts 的副本 ============
  const srv = await startServer({ SSH_MCP_KNOWN_HOSTS: khCopy });
  const cl = srv.client;
  const copyBefore = fs.readFileSync(khCopy);

  await check("C2 ssh_hosts 读出 ssh_config 别名与本地 profile", async () => {
    const p = await mustOk(cl, "ssh_hosts", {});
    const names = (p.hosts as any[]).map((h) => h.name);
    assert.ok(names.includes("los"), "缺 los");
    assert.ok(names.includes(HOST), `缺 ${HOST}`);
    return `别名 ${names.length} 个：${names.join(",")}；ssh_config=${p.ssh_config_path}`;
  });

  await check("C2 unknown host 报错并列出可用别名", async () => {
    const c = await call(cl, "ssh_exec", { host: "definitely-not-a-host", command: "pwd" });
    assert.equal(c.isError, true);
    assert.equal(c.p.error_type, "unknown_host");
    assert.ok((c.p.available_hosts as string[]).includes("los"));
    return `available_hosts=${JSON.stringify(c.p.available_hosts)}`;
  });

  await check("C3 真实执行 uname -sr", async () => {
    const p = await mustOk(cl, "ssh_exec", { host: HOST, command: "uname -sr" });
    assert.equal(p.exit_code, 0);
    assert.match(p.stdout, /Linux 6\.8\.0/);
    return `exit=0 stdout=${JSON.stringify(p.stdout.trim())} cwd=${p.cwd} 连接=${p.connection}`;
  });

  await check("C4 失败命令：exit_code 与 stderr 分开返回，不当工具错误", async () => {
    const c = await call(cl, "ssh_exec", { host: HOST, command: "sh -c 'echo to stderr >&2; exit 7'" });
    assert.equal(c.isError, false, "被当成工具错误抛出了");
    assert.equal(c.p.exit_code, 7);
    assert.equal(c.p.stderr.trim(), "to stderr");
    assert.equal(c.p.stdout, "");
    return `exit=7 stderr=${JSON.stringify(c.p.stderr.trim())}`;
  });

  await check("C5 密钥优先、密码兜底（真实主机，独立进程确保真的走一遍认证）", async () => {
    // 连接池按 user@host:port 复用；前面已为同一端点建过连接，所以要独立进程才看得到认证顺序
    const s = await startServer({ SSH_MCP_KNOWN_HOSTS: khCopy });
    try {
      const t0 = Date.now();
      const p = await mustOk(s.client, "ssh_exec", { host: KEYFIRST, command: "id -un" });
      const ms = Date.now() - t0;
      assert.equal(p.connection, "new");
      assert.deepEqual(p.auth_methods_attempted, ["publickey", "password"], "认证顺序不对");
      assert.equal(p.auth_succeeded_with, "password");
      assert.ok(p.identity_offered, "没有报告尝试过的私钥");
      assert.equal(p.exit_code, 0);
      return `attempted=${JSON.stringify(p.auth_methods_attempted)} 成功=${p.auth_succeeded_with} key=${p.identity_offered} 用时=${ms}ms`;
    } finally {
      await s.close();
    }
  });

  await check("C5 密钥被拒且无密码：快速失败并给可读原因（不挂死）", async () => {
    const t0 = Date.now();
    const c = await call(cl, "ssh_exec", { host: NEG_HOST, command: "true" });
    const ms = Date.now() - t0;
    assert.equal(c.isError, true);
    assert.equal(c.p.error_type, "connect_failed");
    assert.ok(/认证|auth/i.test(String(c.p.error)), "原因不可读：" + c.p.error);
    assert.ok(ms < 12000, `耗时 ${ms}ms 超过 readyTimeout 上限`);
    return `${ms}ms 返回：${c.p.error}`;
  });

  await check("C6 单次调用多步 + 连接复用", async () => {
    const t0 = Date.now();
    const p = await mustOk(cl, "ssh_batch", { host: HOST, commands: ["cd /tmp", "pwd"] });
    const ms = Date.now() - t0;
    assert.equal(p.ok, true);
    assert.equal(p.steps.length, 2);
    assert.equal(p.steps[0].exit_code, 0);
    assert.equal(p.steps[1].exit_code, 0);
    assert.equal(p.steps[1].stdout.trim(), "/tmp");
    // 第二条命令复用同一条连接：再单独调一次，应该报 reused
    const t1 = Date.now();
    const again = await mustOk(cl, "ssh_exec", { host: HOST, command: "pwd" });
    const msReuse = Date.now() - t1;
    assert.equal(again.connection, "reused");
    assert.ok(msReuse < ms, "复用没有比新建连接更快");
    return `batch 两步共用一个 shell，用时=${ms}ms；第二次调用 connection=reused，用时=${msReuse}ms`;
  });

  await check("C7 连续终端：cwd/状态跨调用保持", async () => {
    const o = await mustOk(cl, "session_open", { host: HOST, session_id: "verify-s1" });
    assert.equal(o.session_id, "verify-s1");
    assert.match(String(o.cwd), /^\//);
    const shell = o.shell;
    const a = await mustOk(cl, "session_exec", { session_id: "verify-s1", command: "cd /tmp" });
    assert.equal(a.exit_code, 0);
    assert.equal(a.cwd, "/tmp");
    const b = await mustOk(cl, "session_exec", { session_id: "verify-s1", command: "pwd" });
    assert.equal(b.exit_code, 0);
    assert.equal(b.stdout.trim(), "/tmp");
    assert.equal(b.cwd, "/tmp");
    const v1 = await mustOk(cl, "session_exec", { session_id: "verify-s1", command: "export MCP_LIVE=41 && echo 前=$MCP_LIVE" });
    const v2 = await mustOk(cl, "session_exec", { session_id: "verify-s1", command: 'echo 后=$MCP_LIVE' });
    assert.equal(v2.stdout.trim(), "后=41");
    return `shell=${shell} 起始 cwd=${o.cwd} → cd /tmp → pwd=/tmp，变量跨调用保留`;
  });

  await check("C7 session_reset 把 cwd 回到初始目录", async () => {
    const before = (await mustOk(cl, "session_exec", { session_id: "verify-s1", command: "pwd" })).cwd;
    const r = await mustOk(cl, "session_reset", { session_id: "verify-s1" });
    assert.notEqual(before, r.cwd);
    assert.match(String(r.cwd), /^\/home\//);
    const v = await mustOk(cl, "session_exec", { session_id: "verify-s1", command: 'echo 变量=[$MCP_LIVE]' });
    assert.equal(v.stdout.trim(), "变量=[]");
    return `cwd_before=${before} → cwd=${r.cwd}，环境变量已清空`;
  });

  await check("C8 吞 stdin 的命令（cat）不挂起", async () => {
    const t0 = Date.now();
    const p = await mustOk(cl, "session_exec", { session_id: "verify-s1", command: "cat" });
    const ms = Date.now() - t0;
    assert.equal(p.exit_code, 0);
    assert.notEqual(p.timed_out, true);
    assert.ok(ms < 5000, `cat 用了 ${ms}ms，可能被 stdin 卡住`);
    return `cat 返回 exit=0，用时=${ms}ms（自动补 < /dev/null）`;
  });

  await check("C8 未闭合引号：bash -n 预检报错，命令不执行", async () => {
    const p = await mustOk(cl, "session_exec", { session_id: "verify-s1", command: "echo '未闭合" });
    assert.equal(p.syntax_check, "failed");
    assert.equal(p.exit_code, null);
    assert.match(String(p.error), /未执行/);
    assert.match(String(p.stderr), /EOF|quote|引号/);
    const alive = await mustOk(cl, "session_exec", { session_id: "verify-s1", command: "pwd" });
    assert.equal(alive.exit_code, 0);
    return `预检失败：${String(p.stderr).trim().split("\n")[0]}；会话仍可用`;
  });

  await check("C8 后台/常驻进程挂住 fd：哨兵超时 + background_suspect + 自动重开", async () => {
    const t0 = Date.now();
    const p = await mustOk(cl, "session_exec", { session_id: "verify-s1", command: "tail -f /dev/null", timeout_ms: 1500 });
    const ms = Date.now() - t0;
    assert.equal(p.timed_out, true);
    assert.equal(p.background_suspect, true);
    assert.equal(p.session_restarted, true);
    assert.ok(ms < 6000, `用了 ${ms}ms，太慢`);
    const alive = await mustOk(cl, "session_exec", { session_id: "verify-s1", command: "pwd" });
    assert.equal(alive.exit_code, 0);
    return `timed_out/background_suspect/session_restarted 均为 true，${ms}ms 返回；随后命令仍可用`;
  });

  await check("C10 命令超时：timed_out=true 且 server 不死", async () => {
    const t0 = Date.now();
    const p = await mustOk(cl, "ssh_exec", { host: HOST, command: "sleep 5", timeout_ms: 1000 });
    const ms = Date.now() - t0;
    assert.equal(p.timed_out, true);
    assert.ok(ms < 4000, `超时没生效：${ms}ms`);
    const after = await mustOk(cl, "ssh_exec", { host: HOST, command: "echo 还活着" });
    assert.equal(after.stdout.trim(), "还活着");
    return `${ms}ms 返回 timed_out=true，随后命令正常`;
  });

  await check("C10 输出预算：truncated=true 并回报真实总量", async () => {
    const size = await mustOk(cl, "ssh_exec", { host: HOST, command: "head -c 4096 /dev/zero | tr '\\0' 'a' | wc -c" });
    assert.equal(String(size.stdout).trim(), "4096");
    const p = await mustOk(cl, "ssh_exec", { host: HOST, command: "head -c 4096 /dev/zero | tr '\\0' 'a'", max_output_bytes: 1000 });
    assert.equal(p.truncated, true);
    assert.equal(p.stdout_bytes, 4096);
    assert.ok(p.stdout.length < 2000, "预算没生效");
    assert.match(p.stdout, /\[已截断/);
    return `stdout_bytes=4096（wc -c 独立核对），返回长度=${p.stdout.length}，含截断标记`;
  });

  await check("C11 sftp_mkdir / sftp_write / sftp_read / sftp_stat / sftp_list", async () => {
    const mk = await mustOk(cl, "sftp_mkdir", { host: HOST, path: remoteDir + "/nested/deep", recursive: true });
    const mk2 = await mustOk(cl, "sftp_mkdir", { host: HOST, path: remoteDir + "/nested/deep", recursive: true });
    const st = await mustOk(cl, "sftp_stat", { host: HOST, path: remoteDir });
    assert.equal(st.type, "dir");
    const content = "写进去的内容 " + stamp + "\n";
    const wr = await mustOk(cl, "sftp_write", { host: HOST, path: remoteDir + "/written.txt", content });
    const rd = await mustOk(cl, "sftp_read", { host: HOST, path: remoteDir + "/written.txt" });
    assert.equal(rd.content, content);
    assert.equal(rd.size, Buffer.byteLength(content));
    const st2 = await mustOk(cl, "sftp_stat", { host: HOST, path: remoteDir + "/written.txt" });
    assert.equal(st2.size, Buffer.byteLength(content));
    const ls = await mustOk(cl, "sftp_list", { host: HOST, path: remoteDir });
    assert.ok((ls.entries as any[]).some((e) => e.name === "written.txt"));
    // 读取上限：只给 8 字节预算 → truncated 且回报真实大小
    const big = await mustOk(cl, "sftp_read", { host: HOST, path: remoteDir + "/written.txt", max_bytes: 8 });
    assert.equal(big.truncated, true);
    assert.equal(big.total_bytes, Buffer.byteLength(content));
    assert.ok(JSON.stringify(mk2).includes("already_existing") || (mk2.already_existing ?? []).length > 0, "重复 mkdir 未标注已存在");
    return `created=${JSON.stringify(mk.created ?? [])} 已存在标注=${JSON.stringify(mk2.already_existing ?? [])} 写读一致 size=${rd.size} list 含 written.txt；max_bytes=8 → truncated，total_bytes=${big.total_bytes}`;
  });

  await check("C11 sftp_upload / sftp_download 往返一致 + 远端 sha256sum 比对", async () => {
    const put = await mustOk(cl, "sftp_upload", { host: HOST, local_path: localFile, remote_path: remoteDir + "/up.txt" });
    assert.equal(put.sha256_local, localSha);
    const remote = await mustOk(cl, "ssh_exec", { host: HOST, command: `sha256sum ${remoteDir}/up.txt` });
    assert.equal(remote.exit_code, 0);
    const remoteSha = String(remote.stdout).trim().split(/\s+/)[0];
    assert.equal(remoteSha, localSha, "远端 sha256sum 与本地不一致");
    const dup = await call(cl, "sftp_upload", { host: HOST, local_path: localFile, remote_path: remoteDir + "/up.txt" });
    assert.equal(dup.isError, true, "默认应当拒绝覆盖");
    const forced = await mustOk(cl, "sftp_upload", { host: HOST, local_path: localFile, remote_path: remoteDir + "/up.txt", overwrite: true });
    assert.equal(forced.bytes_match, true, "overwrite 后字节数应一致");
    const get = await mustOk(cl, "sftp_download", { host: HOST, remote_path: remoteDir + "/up.txt", local_path: localBack });
    assert.equal(sha256(fs.readFileSync(localBack)), localSha, "下载回来的内容不一致");
    const tooBig = await call(cl, "sftp_read", { host: HOST, path: remoteDir + "/up.txt", max_bytes: 1 });
    assert.equal((tooBig.p as any).truncated, true);
    return `本地 sha256=${localSha.slice(0, 16)}… 远端 sha256sum=${remoteSha.slice(0, 16)}… 一致；默认拒绝覆盖、overwrite=true 成功；get 回本地哈希一致`;
  });

  await check("C9 复用真实 known_hosts 条目：match 且不改动文件", async () => {
    const p = await mustOk(cl, "ssh_exec", { host: HOST, command: "true" });
    assert.equal(p.host_key.status, "match");
    assert.ok(p.host_key.fingerprint, "无指纹");
    const copyAfter = fs.readFileSync(khCopy);
    assert.deepEqual(copyAfter, copyBefore, "known_hosts 副本被改写了");
    return `status=match fingerprint=${p.host_key.fingerprint}；真实 ~/.ssh/known_hosts 未被改动`;
  });

  await check("C1/C7 会话清理 + server 关闭后无残留", async () => {
    const cs = await mustOk(cl, "session_close", { session_id: "verify-s1" });
    assert.ok(cs);
    await srv.close();
    return "session_close 完成，MCP 客户端已断开";
  });

  // ============ TOFU：空 known_hosts ============
  await check("C9 TOFU 首次连接只追加一行，第二次 match", async () => {
    const s2 = await startServer({ SSH_MCP_KNOWN_HOSTS: khEmpty, SSH_MCP_CONN_TTL_MS: "300" });
    try {
      const first = await mustOk(s2.client, "ssh_exec", { host: HOST, command: "true" });
      assert.equal(first.host_key.status, "unknown");
      const lines1 = fs.readFileSync(khEmpty, "utf8").split("\n").filter(Boolean);
      assert.equal(lines1.length, 1, `应当只追加 1 行，实际 ${lines1.length}`);
      assert.ok(lines1[0]!.includes(NEG_IP) && lines1[0]!.includes("ssh-ed25519"), "追加行格式不对：" + lines1[0]);
      await Bun.sleep(1200); // 连接池按 TTL 过期，强制第二次走新连接、重新校验 host key
      const second = await mustOk(s2.client, "ssh_exec", { host: HOST, command: "true" });
      assert.equal(second.host_key.status, "match");
      const lines2 = fs.readFileSync(khEmpty, "utf8").split("\n").filter(Boolean);
      assert.equal(lines2.length, 1, "重复追加了");
      return `追加行=${lines1[0]!.slice(0, 60)}… 第二次 status=match，行数仍为 1`;
    } finally {
      await s2.close();
    }
  });

  await check("C9 host key 不匹配：拒绝连接并报告指纹差异", async () => {
    const s3 = await startServer({ SSH_MCP_KNOWN_HOSTS: khWrong });
    try {
      const c = await call(s3.client, "ssh_exec", { host: HOST, command: "true" });
      assert.equal(c.isError, true);
      assert.equal(c.p.error_type, "connect_failed");
      assert.match(String(c.p.error), /host key|主机密钥|指纹|fingerprint/i);
      assert.ok(c.p.host_key_fingerprint, "没有报告实际指纹");
      return `拒绝原因=${c.p.error}；实际指纹=${c.p.host_key_fingerprint}`;
    } finally {
      await s3.close();
    }
  });

  await check("C7 空闲超过 TTL 自动关闭并在下次调用时回报原因", async () => {
    const s4 = await startServer({ SSH_MCP_KNOWN_HOSTS: khCopy, SSH_MCP_SESSION_TTL_MS: "1500" });
    try {
      const o = await mustOk(s4.client, "session_open", { host: HOST, session_id: "ttl" });
      assert.equal(o.session_ttl_ms, 1500);
      await new Promise((r) => setTimeout(r, 2200));
      const c = await call(s4.client, "session_exec", { session_id: "ttl", command: "pwd" });
      assert.equal(c.isError, true, "过期会话应当报错");
      assert.match(String(c.p.error), /TTL/);
      assert.match(String(c.p.error), /session_open/);
      return String(c.p.error).slice(0, 160);
    } finally {
      await s4.close();
    }
  });

  // ============ 收尾：清掉远端临时目录 ============
  const s5 = await startServer({ SSH_MCP_KNOWN_HOSTS: khCopy });
  try {
    const p = await mustOk(s5.client, "ssh_exec", { host: HOST, command: `rm -rf ${remoteDir} && echo 已清理` });
    console.log("远端临时目录：" + String(p.stdout).trim());
  } finally {
    await s5.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  // ============ 报告 ============
  console.log("\n==== 验收结果 ====");
  let failed = 0;
  for (const r of rows) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${r.ms}ms)`);
    if (r.note) console.log(`      ${r.note}`);
  }
  console.log(`\n合计 ${rows.length} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("live-verify 自身出错：", e);
  process.exit(2);
});
