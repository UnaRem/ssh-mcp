/**
 * scripts/live-verify.ts —— 真实主机端到端验收（对外的两工具契约）
 *
 * 跑法：bun run live
 * 凭据来源：config.local.json（已被 .gitignore 忽略）或 SSH_MCP_PASSWORD*；本文件不含明文密码。
 *
 * 说明：整个验收过程用一份「真实 known_hosts 的副本」作为 SSH_MCP_KNOWN_HOSTS，
 * 这样既验证了对既有条目的复用，又保证不动 ~/.ssh/known_hosts 本身。
 * 退出码：全部通过 0，任一失败 1。
 *
 * 验收内容按契约组织：桥补的能力（认证、host key、连接复用、退出码分离、输出预算、会话状态）
 * 与桥刻意不补的东西（多步、取区间、写文件、建目录都靠原生命令）都要有证据。
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

/** 必须是 isError=false 的调用（命令 exit_code != 0 不算工具错误），否则抛出错误文本 */
async function call2(client: Client, name: string, args: Record<string, unknown>) {
  const c = await call(client, name, args);
  if (c.isError) throw new Error(`${name} 返回工具错误：${c.text.slice(0, 400)}`);
  return c.p;
}

/** 断言工具错误的错误码属于枚举里的某一个，并返回该负载 */
async function expectError(client: Client, name: string, args: Record<string, unknown>, code: string) {
  const c = await call(client, name, args);
  assert.equal(c.isError, true, `${name} 应当是工具错误，实际成功：${c.text.slice(0, 200)}`);
  assert.equal(c.p.error_code, code, `error_code 应为 ${code}，实际：${c.text.slice(0, 300)}`);
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
  const localFile = path.join(tmp, "upload.bin");
  const localBack = path.join(tmp, "downloaded.bin");
  // 二进制内容：验证「原样搬运」而不是按文本处理
  const payload = Buffer.alloc(4096);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) % 256;
  fs.writeFileSync(localFile, payload);
  const localSha = sha256(payload);

  console.log(`验收主机别名=${HOST}  临时目录=${tmp}`);
  console.log(`known_hosts 副本=${khCopy}（原文件不动）`);

  // ============ 主 server：使用真实 known_hosts 的副本 ============
  const srv = await startServer({ SSH_MCP_KNOWN_HOSTS: khCopy });
  const cl = srv.client;
  const copyBefore = fs.readFileSync(khCopy);

  await check("A1 对外只有两个工具", async () => {
    const listed = await cl.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["ssh_file", "ssh_run"], "工具面漂移：" + names.join(","));
    return `tools=${names.join(",")}；描述都含 Keywords=${listed.tools.every((t) => String(t.description).includes("Keywords:"))}`;
  });

  await check("A2 不传任何参数 = 自省（主机清单 + 配置来源 + 活动状态）", async () => {
    const p = await call2(cl, "ssh_run", {});
    assert.equal(p.mode, "inventory");
    const names = (p.hosts as any[]).map((h) => h.name);
    assert.ok(names.includes("los"), "缺 los");
    assert.ok(names.includes(HOST), `缺 ${HOST}`);
    assert.ok(Array.isArray(p.active_sessions) && Array.isArray(p.active_connections));
    return `别名 ${names.length} 个：${names.join(",")}；ssh_config=${p.ssh_config_path}`;
  });

  await check("A3 未知主机：error_code=unknown_host 并回可用别名", async () => {
    const p = await expectError(cl, "ssh_run", { host: "definitely-not-a-host", command: "pwd" }, "unknown_host");
    assert.ok((p.available_hosts as string[]).includes("los"));
    assert.ok((p.available_hosts as string[]).includes(HOST));
    return `available_hosts=${JSON.stringify(p.available_hosts)}`;
  });

  await check("A4 真实执行 uname -sr", async () => {
    const p = await call2(cl, "ssh_run", { host: HOST, command: "uname -sr" });
    assert.equal(p.exit_code, 0);
    assert.equal(p.ok, true);
    assert.match(p.stdout, /Linux 6\.8\.0/);
    return `exit=0 stdout=${JSON.stringify(p.stdout.trim())} cwd=${p.cwd} 连接=${p.connection}`;
  });

  await check("A4 失败命令是数据：isError=false、顶层 ok=false、exit_code 与 stderr 分开", async () => {
    const c = await call(cl, "ssh_run", { host: HOST, command: "sh -c 'echo to stderr >&2; exit 7'" });
    assert.equal(c.isError, false, "被当成工具错误抛出了");
    assert.equal(c.p.ok, false, "命令失败时顶层 ok 必须是 false");
    assert.equal(c.p.exit_code, 7);
    assert.equal(c.p.stderr.trim(), "to stderr");
    assert.equal(c.p.stdout, "");
    return `exit=7 ok=false stderr=${JSON.stringify(c.p.stderr.trim())}`;
  });

  await check("A5 密钥优先、密码兜底（独立进程确保真的走一遍认证）", async () => {
    // 连接池按 user@host:port 复用；前面已为同一端点建过连接，所以要独立进程才看得到认证顺序
    const s = await startServer({ SSH_MCP_KNOWN_HOSTS: khCopy });
    try {
      const t0 = Date.now();
      const p = await call2(s.client, "ssh_run", { host: KEYFIRST, command: "id -un" });
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

  await check("A5 密钥被拒且无密码：error_code=auth_failed，快速失败不挂死", async () => {
    const t0 = Date.now();
    const p = await expectError(cl, "ssh_run", { host: NEG_HOST, command: "true" }, "auth_failed");
    const ms = Date.now() - t0;
    assert.ok(/认证|auth/i.test(String(p.error)), "原因不可读：" + p.error);
    assert.ok(ms < 12000, `耗时 ${ms}ms 超过 readyTimeout 上限`);
    return `${ms}ms 返回：${p.error}`;
  });

  await check("A6 多步用 &&（无 commands 参数），单条命令一次往返 + 连接复用", async () => {
    const t0 = Date.now();
    const p = await call2(cl, "ssh_run", { host: HOST, command: `mkdir -p ${remoteDir} && cd ${remoteDir} && pwd` });
    const ms = Date.now() - t0;
    assert.equal(p.exit_code, 0);
    assert.equal(p.stdout.trim(), remoteDir);
    const t1 = Date.now();
    const again = await call2(cl, "ssh_run", { host: HOST, command: "pwd" });
    const msReuse = Date.now() - t1;
    assert.equal(again.connection, "reused");
    assert.ok(msReuse < ms, "复用没有比新建连接更快");
    return `一条命令完成 mkdir+cd+pwd，用时=${ms}ms；第二次 connection=reused，用时=${msReuse}ms`;
  });

  let keepId = "";
  await check("A7 session=keep：建立并跨调用保持 cwd 与 env", async () => {
    const o = await call2(cl, "ssh_run", { host: HOST, session: "keep", command: `cd ${remoteDir} && export MCP_LIVE=41 && pwd` });
    keepId = String(o.session_id);
    assert.match(keepId, /^s_/);
    assert.equal(o.exit_code, 0);
    assert.equal(o.cwd, remoteDir);
    assert.ok(o.idle_ttl_ms > 0);
    // 第二次不传 host：只有一个活动会话时自动复用（更聪明的默认值）
    const b = await call2(cl, "ssh_run", { session: "keep", command: "pwd && echo 变量=$MCP_LIVE" });
    assert.equal(b.session_id, keepId);
    assert.equal(b.cwd, remoteDir);
    assert.equal(b.stdout.trim(), `${remoteDir}\n变量=41`);
    return `session_id=${keepId} cwd=${b.cwd} env 跨调用保留（省掉 host 也复用了同一个 shell）`;
  });

  await check("A7 session_op=reset：回到登录目录且 env 清空", async () => {
    const r = await call2(cl, "ssh_run", { session: keepId, session_op: "reset" });
    assert.notEqual(r.cwd_before, r.cwd);
    assert.match(String(r.cwd), /^\/home\//);
    const v = await call2(cl, "ssh_run", { session: keepId, command: "echo 变量=[$MCP_LIVE]" });
    assert.equal(v.stdout.trim(), "变量=[]");
    return `cwd_before=${r.cwd_before} → cwd=${r.cwd}，环境变量已清空`;
  });

  await check("A8 吞 stdin 的命令（cat）不挂起", async () => {
    const t0 = Date.now();
    const p = await call2(cl, "ssh_run", { session: keepId, command: "cat" });
    const ms = Date.now() - t0;
    assert.equal(p.exit_code, 0);
    assert.notEqual(p.timed_out, true);
    assert.ok(ms < 5000, `cat 用了 ${ms}ms，可能被 stdin 卡住`);
    return `cat 返回 exit=0，用时=${ms}ms（桥自动补 < /dev/null，不需要参数）`;
  });

  await check("A8 未闭合引号：bash -n 预检报错，命令不执行，会话仍可用", async () => {
    const p = await call2(cl, "ssh_run", { session: keepId, command: "echo '未闭合" });
    assert.equal(p.syntax_check, "failed");
    assert.equal(p.exit_code, null);
    assert.match(String(p.error), /未执行/);
    assert.match(String(p.stderr), /EOF|quote|引号/);
    const alive = await call2(cl, "ssh_run", { session: keepId, command: "pwd" });
    assert.equal(alive.exit_code, 0);
    return `预检失败：${String(p.stderr).trim().split("\n")[0]}；会话仍可用`;
  });

  await check("A8 后台进程挂住 fd：哨兵超时 + background_suspect + 自动重开", async () => {
    const t0 = Date.now();
    const p = await call2(cl, "ssh_run", { session: keepId, command: "tail -f /dev/null", timeout_ms: 1500 });
    const ms = Date.now() - t0;
    assert.equal(p.timed_out, true);
    assert.equal(p.background_suspect, true);
    assert.equal(p.session_restarted, true);
    assert.ok(ms < 6000, `用了 ${ms}ms，太慢`);
    const alive = await call2(cl, "ssh_run", { session: keepId, command: "pwd" });
    assert.equal(alive.exit_code, 0);
    return `timed_out/background_suspect/session_restarted 均为 true，${ms}ms 返回；随后命令仍可用`;
  });

  await check("A9 命令超时：timed_out=true 且 server 不死", async () => {
    const t0 = Date.now();
    const p = await call2(cl, "ssh_run", { host: HOST, command: "sleep 5", timeout_ms: 1000 });
    const ms = Date.now() - t0;
    assert.equal(p.timed_out, true);
    assert.ok(ms < 4000, `超时没生效：${ms}ms`);
    const after = await call2(cl, "ssh_run", { host: HOST, command: "echo 还活着" });
    assert.equal(after.stdout.trim(), "还活着");
    return `${ms}ms 返回 timed_out=true，随后命令正常`;
  });

  await check("A9 输出预算：truncated=true 并回报真实总量", async () => {
    const size = await call2(cl, "ssh_run", { host: HOST, command: "head -c 4096 /dev/zero | tr '\\0' 'a' | wc -c" });
    assert.equal(String(size.stdout).trim(), "4096");
    const p = await call2(cl, "ssh_run", { host: HOST, command: "head -c 4096 /dev/zero | tr '\\0' 'a'", max_output_bytes: 1000 });
    assert.equal(p.truncated, true);
    assert.equal(p.stdout_bytes, 4096);
    assert.ok(p.stdout.length < 2000, "预算没生效");
    assert.match(p.stdout, /\[已截断/);
    return `stdout_bytes=4096（wc -c 独立核对），返回长度=${p.stdout.length}，含截断标记`;
  });

  await check("A10 文件操作走原生命令：heredoc 写 + sed 区间 + grep 过滤", async () => {
    const w = await call2(cl, "ssh_run", {
      host: HOST,
      command: `cat > ${remoteDir}/conf.conf <<'EOF'\nfirst=1\nsecond=2\nthird=3\nEOF\nwc -l < ${remoteDir}/conf.conf`,
    });
    assert.equal(w.exit_code, 0);
    assert.equal(String(w.stdout).trim(), "3");
    const mid = await call2(cl, "ssh_run", { host: HOST, command: `sed -n '2p' ${remoteDir}/conf.conf` });
    assert.equal(mid.stdout.trim(), "second=2");
    const cnt = await call2(cl, "ssh_run", { host: HOST, command: `grep -c '=' ${remoteDir}/conf.conf` });
    assert.equal(cnt.stdout.trim(), "3");
    return "heredoc 写入 3 行，sed -n '2p' 与 grep -c 都由远端 shell 完成（没有 read/write 参数）";
  });

  await check("A11 ssh_file put/get：字节与 sha256 一致，远端 sha256sum 交叉核对", async () => {
    const put = await call2(cl, "ssh_file", { host: HOST, entries: [{ op: "put", remote_path: `${remoteDir}/up.bin`, local_path: localFile }] });
    assert.equal(put.ok, true);
    assert.equal(put.entries[0].bytes_match, true);
    assert.equal(put.entries[0].sha256_local, localSha);
    const remote = await call2(cl, "ssh_run", { host: HOST, command: `sha256sum ${remoteDir}/up.bin` });
    assert.equal(String(remote.stdout).trim().split(/\s+/)[0], localSha, "远端 sha256sum 与本地不一致");
    const back = await call2(cl, "ssh_file", { host: HOST, entries: [{ op: "get", remote_path: `${remoteDir}/up.bin`, local_path: localBack }] });
    assert.equal(back.entries[0].bytes_match, true);
    assert.equal(sha256(fs.readFileSync(localBack)), localSha, "下载回来的内容不一致");
    return `本地 sha256=${localSha.slice(0, 16)}… 远端 sha256sum 一致；get 回本地字节一致`;
  });

  await check("A11 默认拒绝覆盖：条目带 error_code=exists（是数据，不是工具错误），overwrite=true 才覆盖", async () => {
    const dup = await call(cl, "ssh_file", { host: HOST, entries: [{ op: "put", remote_path: `${remoteDir}/up.bin`, local_path: localFile }] });
    assert.equal(dup.isError, false, "单条失败不应是工具错误");
    assert.equal(dup.p.ok, false);
    assert.equal(dup.p.entries[0].error_code, "exists");
    const forced = await call2(cl, "ssh_file", {
      host: HOST,
      entries: [{ op: "put", remote_path: `${remoteDir}/up.bin`, local_path: localFile, overwrite: true }],
    });
    assert.equal(forced.entries[0].bytes_match, true, "overwrite 后字节数应一致");
    return `拒绝原因=${dup.p.entries[0].error}；overwrite=true 后 bytes_match=true`;
  });

  await check("A11 一条连接传多个条目，按请求顺序返回；op 写错整体拒绝", async () => {
    const multi = await call2(cl, "ssh_file", {
      host: HOST,
      entries: [
        { op: "put", remote_path: `${remoteDir}/a.txt`, local_path: localFile },
        { op: "get", remote_path: `${remoteDir}/a.txt`, local_path: path.join(tmp, "a.copy") },
        { op: "get", remote_path: `${remoteDir}/missing-xyz`, local_path: path.join(tmp, "no.copy") },
      ],
    });
    assert.equal(multi.total, 3);
    assert.equal(multi.failed, 1);
    assert.deepEqual(multi.entries.map((e: any) => e.op), ["put", "get", "get"]);
    assert.equal(multi.entries[2].error_code, "not_found");
    assert.equal(sha256(fs.readFileSync(path.join(tmp, "a.copy"))), localSha);
    const bad = await expectError(cl, "ssh_file", { host: HOST, entries: [{ op: "list", remote_path: "/tmp", local_path: localFile }] }, "bad_input");
    assert.deepEqual(bad.allowed_ops, ["put", "get"]);
    // 用法错误与连接无关：不能把同主机的连接与会话一起杀掉（实测曾因此让 keep 会话消失）
    const inv = await call2(cl, "ssh_run", {});
    assert.ok((inv.active_sessions as any[]).some((s) => s.session_id === keepId), "错误调用后 keep 会话不见了");
    assert.ok((inv.active_connections as string[]).length > 0, "错误调用后连接池被清空了");
    return `3 条共用一条 SFTP 连接；第 3 条 not_found；op=list 被拒并列出 allowed_ops；错误调用未影响连接与会话`;
  });

  await check("A12 复用真实 known_hosts 条目：match 且不改动文件", async () => {
    const p = await call2(cl, "ssh_run", { host: HOST, command: "true" });
    assert.equal(p.host_key.status, "match");
    assert.ok(p.host_key.fingerprint, "无指纹");
    const copyAfter = fs.readFileSync(khCopy);
    assert.deepEqual(copyAfter, copyBefore, "known_hosts 副本被改写了");
    return `status=match fingerprint=${p.host_key.fingerprint}；真实 ~/.ssh/known_hosts 未被改动`;
  });

  await check("A2 参数多余不静默丢弃（strict schema）", async () => {
    const c = await call(cl, "ssh_run", { host: HOST, command: "true", user: "root", port: 22 });
    assert.equal(c.isError, true, "多余参数应被拒");
    assert.match(c.text, /user/);
    const listed = await cl.listTools();
    const run = listed.tools.find((t) => t.name === "ssh_run")!;
    assert.equal((run.inputSchema as any).additionalProperties, false, "发布的 schema 应说明只接受这些参数");
    return "user/port 被拒；published additionalProperties=false";
  });

  await check("A1 会话清理 + server 关闭后无残留", async () => {
    const cs = await call2(cl, "ssh_run", { session: keepId, session_op: "close" });
    assert.deepEqual(cs.remaining, []);
    await srv.close();
    return "session_op=close 完成，remaining=[]，MCP 客户端已断开";
  });

  // ============ TOFU：空 known_hosts ============
  await check("A13 TOFU 首次连接只追加一行，第二次 match", async () => {
    const s2 = await startServer({ SSH_MCP_KNOWN_HOSTS: khEmpty, SSH_MCP_CONN_TTL_MS: "300" });
    try {
      const first = await call2(s2.client, "ssh_run", { host: HOST, command: "true" });
      assert.equal(first.host_key.status, "unknown");
      const lines1 = fs.readFileSync(khEmpty, "utf8").split("\n").filter(Boolean);
      assert.equal(lines1.length, 1, `应当只追加 1 行，实际 ${lines1.length}`);
      assert.ok(lines1[0]!.includes(NEG_IP) && lines1[0]!.includes("ssh-ed25519"), "追加行格式不对：" + lines1[0]);
      await Bun.sleep(1200); // 连接池按 TTL 过期，强制第二次走新连接、重新校验 host key
      const second = await call2(s2.client, "ssh_run", { host: HOST, command: "true" });
      assert.equal(second.host_key.status, "match");
      const lines2 = fs.readFileSync(khEmpty, "utf8").split("\n").filter(Boolean);
      assert.equal(lines2.length, 1, "重复追加了");
      return `追加行=${lines1[0]!.slice(0, 60)}… 第二次 status=match，行数仍为 1`;
    } finally {
      await s2.close();
    }
  });

  await check("A13 host key 不匹配：error_code=host_key_mismatch 并报告实际指纹", async () => {
    const s3 = await startServer({ SSH_MCP_KNOWN_HOSTS: khWrong });
    try {
      const p = await expectError(s3.client, "ssh_run", { host: HOST, command: "true" }, "host_key_mismatch");
      assert.match(String(p.error), /host key|主机密钥|指纹|fingerprint/i);
      assert.ok(p.host_key_fingerprint, "没有报告实际指纹");
      return `拒绝原因=${p.error}；实际指纹=${p.host_key_fingerprint}`;
    } finally {
      await s3.close();
    }
  });

  await check("A14 会话空闲超过 TTL：error_code=no_session 并说明怎么重新开始", async () => {
    const s4 = await startServer({ SSH_MCP_KNOWN_HOSTS: khCopy, SSH_MCP_SESSION_TTL_MS: "1500" });
    try {
      const o = await call2(s4.client, "ssh_run", { host: HOST, session: "keep", command: "pwd" });
      assert.equal(o.idle_ttl_ms, 1500);
      await Bun.sleep(2200);
      const p = await expectError(s4.client, "ssh_run", { session: o.session_id, command: "pwd" }, "no_session");
      assert.match(String(p.error), /TTL/);
      assert.match(String(p.error), /keep/);
      return String(p.error).slice(0, 200);
    } finally {
      await s4.close();
    }
  });

  // ============ 收尾：清掉远端临时目录 ============
  const s5 = await startServer({ SSH_MCP_KNOWN_HOSTS: khCopy });
  try {
    const p = await call2(s5.client, "ssh_run", { host: HOST, command: `rm -rf ${remoteDir} && echo 已清理` });
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
