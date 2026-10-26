// 连接层测试：用 ssh2 自带的 Server 在进程内起一个真实 SSH 服务端，
// 这样「密钥优先、密码兜底、不挂在提示上」和 host key 三种策略都是真实协议行为，
// 不需要联网，也不依赖 192.168.1.21（真实主机由 scripts/live-verify.ts 单独验收）。

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { Client, Server, utils, type AuthContext } from "ssh2";

import { buildConnectConfig, connectTo, describeConnectError, observeAuthAttempt } from "../src/backend.ts";
import type { HostKeyInfo } from "../src/backend.ts";
import { KnownHostsStore, fingerprint } from "../src/knownhosts.ts";
import type { HostKeyPolicy, ResolvedTarget } from "../src/types.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-backend-"));

function pemPair(): { privateKey: string; publicKey: string } {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

const hostKey = pemPair();
const clientKey = pemPair();
const otherKey = pemPair();

function publicBlob(pem: string): Buffer {
  return (utils.parseKey(Buffer.from(pem)) as { getPublicSSH(): Buffer }).getPublicSSH();
}

const PASSWORD = "pw-for-fake-server";

function mkTarget(over: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return {
    alias: "faked",
    hostname: "127.0.0.1",
    port: 22,
    user: "tester",
    sources: ["test"],
    identityFiles: [],
    privateKeys: [],
    hostKeyPolicy: "off",
    ...over,
  };
}

interface FakeServer {
  port: number;
  /** 服务端看到的认证请求顺序，publickey 会先是无签名的探测再是带签名的正式请求 */
  authLog: string[];
  close(): void;
}

const openServers: FakeServer[] = [];

function startFakeServer(acceptPub: Buffer | null): Promise<FakeServer> {
  return new Promise((resolve) => {
    const authLog: string[] = [];
    const conns: Client[] = [];
    const server = new Server({ hostKeys: [Buffer.from(hostKey.privateKey)] }, (conn) => {
      (conns as unknown as Client[]).push(conn as unknown as Client);
      conn.on("authentication", (ctx: AuthContext) => {
        if (ctx.method === "publickey") {
          const match = acceptPub !== null && Buffer.compare(ctx.key.data, acceptPub) === 0;
          authLog.push(`publickey:${ctx.signature !== undefined ? "signed" : "probe"}`);
          if (match) ctx.accept();
          else ctx.reject(["publickey", "password"]);
          return;
        }
        if (ctx.method === "password") {
          authLog.push("password");
          if (ctx.password === PASSWORD) ctx.accept();
          else ctx.reject(["publickey", "password"]);
          return;
        }
        ctx.reject(["publickey", "password"]);
      });
    });
    server.on("error", () => {});
    server.listen(0, "127.0.0.1", () => {
      const s: FakeServer = {
        port: (server.address() as net.AddressInfo).port,
        authLog,
        close: () => {
          for (const c of conns) {
            try {
              c.end();
            } catch {}
          }
          server.close();
        },
      };
      openServers.push(s);
      resolve(s);
    });
  });
}

afterAll(() => {
  for (const s of openServers) s.close();
});

describe("buildConnectConfig：认证顺序与 host key 钩子", () => {
  const nullStore = KnownHostsStore.load(path.join(tmp, "missing-known_hosts"));

  test("密钥 + 密码都在时，顺序必须是 publickey 先、password 后", () => {
    const t = mkTarget({
      identityFiles: ["/x/id_ed25519"],
      privateKeys: [{ path: "/x/id_ed25519", data: Buffer.from(clientKey.privateKey) }],
      password: PASSWORD,
      hostKeyPolicy: "tofu",
    });
    const cfg = buildConnectConfig(t, 0, nullStore, () => {});
    expect(cfg.authHandler).toEqual(["publickey", "password"]);
    expect(cfg.tryKeyboard).toBe(false);
    expect(cfg.privateKey).toBeInstanceOf(Buffer);
    expect(cfg.password).toBe(PASSWORD);
    expect(typeof cfg.hostVerifier).toBe("function");
  });

  test("只有密码时不列 publickey；没有凭据时是空列表", () => {
    const pwOnly = buildConnectConfig(mkTarget({ password: PASSWORD }), 0, nullStore, () => {});
    expect(pwOnly.authHandler).toEqual(["password"]);
    expect(pwOnly.privateKey).toBeUndefined();

    const none = buildConnectConfig(mkTarget(), 0, nullStore, () => {});
    expect(none.authHandler).toEqual([]);
  });

  test("host_key_policy=off 时不挂 hostVerifier", () => {
    const cfg = buildConnectConfig(mkTarget({ hostKeyPolicy: "off", password: "x" }), 0, nullStore, () => {});
    expect(cfg.hostVerifier).toBeUndefined();
  });

  test("observeAuthAttempt 从协议日志里取真实尝试顺序", () => {
    const sink: string[] = [];
    observeAuthAttempt("Outbound: Sending USERAUTH_REQUEST (none)", sink);
    observeAuthAttempt("Outbound: Sending USERAUTH_REQUEST (publickey -- check)", sink);
    observeAuthAttempt("Outbound: Sending USERAUTH_REQUEST (publickey)", sink);
    observeAuthAttempt("Outbound: Sending USERAUTH_REQUEST (password)", sink);
    observeAuthAttempt("Inbound: Received USERAUTH_SUCCESS", sink);
    observeAuthAttempt("Outbound: Sending CHANNEL_OPEN", sink);
    expect(sink).toEqual(["none", "publickey", "password"]);
  });
});

describe("hostVerifier：match / TOFU / strict / mismatch", () => {
  const serverPub = publicBlob(hostKey.privateKey);
  const otherPub = publicBlob(otherKey.privateKey);
  type Verifier = (serverKey: Buffer, verify: (ok: boolean) => void) => void;

  function runVerifier(t: ResolvedTarget, knownHosts: KnownHostsStore, blob: Buffer): Promise<{ info: HostKeyInfo | null; ok: boolean }> {
    return new Promise((resolve) => {
      let info: HostKeyInfo | null = null;
      const cfg = buildConnectConfig(t, 0, knownHosts, (i) => {
        info = i;
      });
      (cfg.hostVerifier as Verifier)(blob, (ok) => resolve({ info, ok }));
    });
  }

  test("已记录且指纹一致：status=match，通过", async () => {
    const p = path.join(tmp, "kh-match");
    const store = KnownHostsStore.load(p);
    store.append("127.0.0.1", 22, serverPub);
    const { info, ok } = await runVerifier(mkTarget({ hostKeyPolicy: "strict" }), store, serverPub);
    expect(ok).toBe(true);
    expect(info?.status).toBe("match");
    expect(info?.fingerprint).toBe(fingerprint(serverPub));
  });

  test("TOFU：unknown 时通过，并把这一行追加进 known_hosts（只追加）", async () => {
    const p = path.join(tmp, "kh-tofu");
    const before = "# 既有内容\n192.0.2.5 ssh-ed25519 AAAAexisting\n";
    fs.writeFileSync(p, before);
    const store = KnownHostsStore.load(p);
    const { info, ok } = await runVerifier(mkTarget({ port: 2222, hostKeyPolicy: "tofu" }), store, serverPub);
    expect(ok).toBe(true);
    expect(info?.status).toBe("unknown");
    expect(info?.appended_line).toContain("[127.0.0.1]:2222");

    const after = fs.readFileSync(p, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.trim().split("\n").length).toBe(3);
  });

  test("strict：unknown 直接拒绝", async () => {
    const store = KnownHostsStore.load(path.join(tmp, "kh-strict-none"));
    const { info, ok } = await runVerifier(mkTarget({ hostKeyPolicy: "strict" }), store, serverPub);
    expect(info?.status).toBe("unknown");
    expect(ok).toBe(false);
  });

  test("mismatch：状态是 mismatch 并带上已记录的指纹", async () => {
    const p = path.join(tmp, "kh-mismatch");
    const store = KnownHostsStore.load(p);
    store.append("127.0.0.1", 22, otherPub);
    const { info, ok } = await runVerifier(mkTarget({ hostKeyPolicy: "tofu" }), store, serverPub);
    expect(ok).toBe(false);
    expect(info?.status).toBe("mismatch");
    expect(info?.recorded.length).toBe(1);
    expect(info?.recorded[0]).toContain(fingerprint(otherPub));
  });
});

describe("describeConnectError：把 ssh2 报错翻译成可操作原因", () => {
  const t = mkTarget({ hostname: "192.0.2.7", port: 22, user: "unarem" });

  test("认证失败：说明试过的密钥，并提示密码兜底在哪配", () => {
    const r = describeConnectError(
      new Error("All configured authentication methods failed"),
      t,
      null,
      ["/home/u/.ssh/id_ed25519"],
      ["publickey", "password"],
    );
    expect(r.reason).toContain("认证失败");
    expect(r.reason).toContain("unarem@192.0.2.7:22");
    expect(r.hint).toContain("id_ed25519");
    expect(r.attempted_methods).toEqual(["publickey", "password"]);
  });

  test("host key 不匹配：给出当前与已记录指纹", () => {
    const hk: HostKeyInfo = { status: "mismatch", fingerprint: "SHA256:aaa", keyType: "ssh-ed25519", recorded: ["已记录 SHA256:zzz"] };
    const r = describeConnectError(new Error("Host denied (verification failed)"), t, hk, [], []);
    expect(r.reason).toContain("host key 不匹配");
    expect(r.hint).toContain("SHA256:zzz");
    expect(r.host_key_fingerprint).toBe("SHA256:aaa");
  });

  test("握手超时 / 端口不可达 / 域名解析失败 都有对应说明", () => {
    expect(describeConnectError(new Error("Timed out while waiting for handshake"), t, null, [], []).reason).toContain("握手超时");
    expect(describeConnectError(new Error("connect ECONNREFUSED 192.0.2.7:22"), t, null, [], []).reason).toContain("连接被拒绝");
    expect(describeConnectError(new Error("getaddrinfo ENOTFOUND nope"), t, null, [], []).reason).toContain("域名解析失败");
  });
});

describe("真实 SSH 协议：认证策略与 host key 行为（进程内服务端）", () => {
  const clientKeyPath = path.join(tmp, "id_client");
  fs.writeFileSync(clientKeyPath, clientKey.privateKey);
  const otherKeyPath = path.join(tmp, "id_other");
  fs.writeFileSync(otherKeyPath, otherKey.privateKey);

  test("服务器接受本地密钥：只走 publickey，不尝试密码", async () => {
    const srv = await startFakeServer(publicBlob(clientKey.privateKey));
    const h = await connectTo(
      mkTarget({
        port: srv.port,
        identityFiles: [clientKeyPath],
        privateKeys: [{ path: clientKeyPath, data: Buffer.from(clientKey.privateKey) }],
        password: PASSWORD,
      }),
      { readyTimeoutMs: 5000, keepaliveMs: 0 },
    );
    expect(srv.authLog).toEqual(["publickey:probe", "publickey:signed"]);
    expect(h.authMethods).toEqual(["publickey"]);
    expect(h.authSucceededWith).toBe("publickey");
    expect(h.identityOffered).toBe(clientKeyPath);
    expect(h.hostKey.status).toBe("skipped");
    h.close();
    srv.close();
  });

  test("密钥被拒：自动用密码兜底完成登录，顺序仍是先密钥后密码", async () => {
    // 服务端只接受另一把 key，客户端这把必然被拒
    const srv = await startFakeServer(publicBlob(otherKey.privateKey));
    const h = await connectTo(
      mkTarget({
        port: srv.port,
        identityFiles: [clientKeyPath],
        privateKeys: [{ path: clientKeyPath, data: Buffer.from(clientKey.privateKey) }],
        password: PASSWORD,
      }),
      { readyTimeoutMs: 5000, keepaliveMs: 0 },
    );
    expect(srv.authLog).toEqual(["publickey:probe", "password"]);
    expect(h.authMethods).toEqual(["publickey", "password"]);
    expect(h.authSucceededWith).toBe("password");
    h.close();
    srv.close();
  });

  test("两条路都不成立：快速失败并给出可读原因，不挂在提示上", async () => {
    const srv = await startFakeServer(publicBlob(otherKey.privateKey));
    const started = Date.now();
    let failed = false;
    try {
      await connectTo(
        mkTarget({
          port: srv.port,
          identityFiles: [clientKeyPath],
          privateKeys: [{ path: clientKeyPath, data: Buffer.from(clientKey.privateKey) }],
          password: "不对的密码",
        }),
        { readyTimeoutMs: 5000, keepaliveMs: 0 },
      );
    } catch (e) {
      failed = true;
      const info = (e as { connectFailure?: { reason: string; hint?: string; attempted_methods: string[] } }).connectFailure;
      expect(info?.reason).toContain("认证失败");
      expect(info?.attempted_methods).toEqual(["publickey", "password"]);
      expect(info?.hint).toContain("id_client");
    }
    expect(failed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    srv.close();
  });

  test("TOFU：首次连接记录 host key，第二次连接是 match，known_hosts 只多一行", async () => {
    const srv = await startFakeServer(publicBlob(clientKey.privateKey));
    const khPath = path.join(tmp, "kh-live");
    fs.writeFileSync(khPath, "");

    const store = KnownHostsStore.load(khPath);
    const target = mkTarget({
      port: srv.port,
      hostKeyPolicy: "tofu",
      password: PASSWORD,
      identityFiles: [clientKeyPath],
      privateKeys: [{ path: clientKeyPath, data: Buffer.from(clientKey.privateKey) }],
    });
    const h1 = await connectTo(target, { readyTimeoutMs: 5000, knownHosts: store });
    expect(h1.hostKey.status).toBe("unknown");
    expect(h1.hostKey.appended_line).toContain(`[127.0.0.1]:${srv.port}`);
    h1.close();
    expect(fs.readFileSync(khPath, "utf8").trim().split("\n").length).toBe(1);

    const h2 = await connectTo(target, { readyTimeoutMs: 5000, knownHosts: KnownHostsStore.load(khPath) });
    expect(h2.hostKey.status).toBe("match");
    expect(h2.hostKey.fingerprint).toBe(fingerprint(publicBlob(hostKey.privateKey)));
    h2.close();
    srv.close();
  });

  test("host key 不匹配：拒绝连接并报告指纹差异", async () => {
    const srv = await startFakeServer(publicBlob(clientKey.privateKey));
    const khPath = path.join(tmp, "kh-live-mismatch");
    const store = KnownHostsStore.load(khPath);
    store.append("127.0.0.1", srv.port, publicBlob(otherKey.privateKey));

    let caught: unknown;
    try {
      await connectTo(mkTarget({ port: srv.port, hostKeyPolicy: "tofu", password: PASSWORD }), {
        readyTimeoutMs: 5000,
        knownHosts: store,
      });
    } catch (e) {
      caught = e;
    }
    const info = (caught as { connectFailure?: { reason: string; host_key_fingerprint?: string } }).connectFailure;
    expect(info?.reason).toContain("host key 不匹配");
    expect(info?.host_key_fingerprint).toBe(fingerprint(publicBlob(hostKey.privateKey)));
    srv.close();
  });

  test("strict 且 known_hosts 无记录：拒绝连接", async () => {
    const srv = await startFakeServer(publicBlob(clientKey.privateKey));
    let caught: unknown;
    try {
      await connectTo(mkTarget({ port: srv.port, hostKeyPolicy: "strict" as HostKeyPolicy, password: PASSWORD }), {
        readyTimeoutMs: 5000,
        knownHosts: KnownHostsStore.load(path.join(tmp, "kh-live-strict")),
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toContain("host key");
    srv.close();
  });

  test("对端不说 SSH 协议：在 readyTimeout 内返回并给出可读原因，不无限等待", async () => {
    // 只接 TCP、不说 SSH 协议 —— 真实场景里就是端口上不是 sshd，或中间设备吞包
    const sink = net.createServer((s) => {
      s.on("data", () => {});
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    const port = (sink.address() as net.AddressInfo).port;

    const started = Date.now();
    let reason = "";
    try {
      await connectTo(mkTarget({ port, password: PASSWORD }), { readyTimeoutMs: 800 });
    } catch (e) {
      reason = ((e as { connectFailure?: { reason: string } }).connectFailure?.reason ?? (e as Error).message);
    }
    const elapsed = Date.now() - started;
    sink.close();
    // 没收到协议头时 ssh2 报 Connection lost before handshake，认证阶段超时报
    // Timed out while waiting for handshake —— 两者都已翻译成中文原因
    expect(reason).toContain("握手");
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(3000);
  });
});
