// 连接层：ssh2 客户端 + 本地凭据 + known_hosts 校验。
//
// 三个必须显式处理的事实（都已在本机核对源码 / 实测）：
// 1) ssh2 的默认认证顺序是 None -> Password -> Private Key，与「本地密钥优先」相反，
//    因此必须显式给出 authHandler: ['publickey', 'password']。
// 2) ssh2 不校验 host key（不传 hostVerifier 时直接接受），因此 TOFU 与不匹配拒绝
//    由 knownhosts.ts 通过 hostVerifier 钩子实现。
// 3) 客户端不告诉我们最终是哪种认证方式成功的。可观测的是协议日志：
//    "Outbound: Sending USERAUTH_REQUEST (publickey -- check)" / "(password)"，
//    据此如实记录真实尝试顺序（见 observeAuthAttempt）。

import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

import type { ConnectFailureInfo, ResolvedTarget } from "./types.ts";
import { KnownHostsStore, type VerifyOutcome } from "./knownhosts.ts";

export interface ConnectOptions {
  readyTimeoutMs?: number;
  keepaliveMs?: number;
  knownHosts?: KnownHostsStore;
}

export interface HostKeyInfo {
  status: VerifyOutcome["status"] | "skipped";
  fingerprint: string;
  keyType: string;
  recorded: string[];
  appended_line?: string;
}

export interface ConnHandle {
  conn: Client;
  target: ResolvedTarget;
  hostKey: HostKeyInfo;
  /** 真实尝试过的认证方式，按尝试顺序；观测不到时退回配置里的顺序 */
  authMethods: string[];
  /** 最终被服务器接受的方式（= 最后一次尝试）；观测不到时省略 */
  authSucceededWith?: string;
  /** 本次 offered 出去的本地私钥路径（不代表它被服务器接受） */
  identityOffered?: string;
  close(): void;
}

const DEFAULT_READY_TIMEOUT = 12_000;
const DEFAULT_KEEPALIVE = 15_000;

/** 从 ssh2 的协议日志里提取真实发出的认证请求 */
export function observeAuthAttempt(msg: string, sink: string[]): void {
  const m = /Sending USERAUTH_REQUEST \(([a-z-]+)/.exec(msg);
  if (!m) return;
  const method = m[1]!;
  if (!sink.includes(method)) sink.push(method);
}

/** 构造 ssh2 连接参数：密钥优先、密码兜底、host key 校验、快速失败 */
export function buildConnectConfig(
  target: ResolvedTarget,
  keyIndex: number,
  knownHosts: KnownHostsStore,
  onHostKey: (info: HostKeyInfo) => void,
  opts: ConnectOptions = {},
  onDebug?: (msg: string) => void,
): ConnectConfig {
  const key = target.privateKeys[keyIndex];
  const methods: string[] = [];
  if (key) methods.push("publickey");
  if (target.password) methods.push("password");

  const cfg: ConnectConfig = {
    host: target.hostname,
    port: target.port,
    username: target.user,
    readyTimeout: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT,
    keepaliveInterval: opts.keepaliveMs ?? DEFAULT_KEEPALIVE,
    keepaliveCountMax: 3,
    // 不做交互式问答：密码只来自本地配置，避免挂在提示上
    tryKeyboard: false,
    authHandler: methods as ConnectConfig["authHandler"],
  };

  // 只用来观测真实认证过程；不改变连接行为
  if (onDebug) cfg.debug = onDebug;

  if (key) {
    cfg.privateKey = key.data;
    if (target.keyPassphrase) cfg.passphrase = target.keyPassphrase;
  }
  if (target.password) cfg.password = target.password;

  if (target.hostKeyPolicy !== "off") {
    cfg.hostVerifier = (serverKey: Buffer, verify: (ok: boolean) => void) => {
      const outcome = knownHosts.verify(target.hostname, target.port, serverKey);
      const info: HostKeyInfo = {
        status: outcome.status,
        fingerprint: outcome.fingerprint,
        keyType: outcome.keyType,
        recorded: outcome.recorded,
      };
      if (outcome.status === "match") {
        onHostKey(info);
        verify(true);
        return;
      }
      if (outcome.status === "unknown") {
        if (target.hostKeyPolicy === "strict") {
          info.recorded = [];
          onHostKey(info);
          verify(false);
          return;
        }
        const appended = knownHosts.append(target.hostname, target.port, serverKey);
        info.appended_line = appended.line;
        onHostKey(info);
        verify(true);
        return;
      }
      // mismatch：明确拒绝
      onHostKey(info);
      verify(false);
    };
  }

  return cfg;
}

/** 把 ssh2 的报错翻译成可操作的原因 */
export function describeConnectError(
  err: Error,
  target: ResolvedTarget,
  hostKey: HostKeyInfo | null,
  triedKeys: string[],
  methods: string[],
): ConnectFailureInfo {
  const msg = err.message || String(err);
  const attempted_methods = methods.slice();

  if (/Host denied \(verification failed\)/.test(msg)) {
    const recorded = hostKey?.recorded ?? [];
    return {
      reason: `host key 不匹配：服务器当前密钥 ${hostKey?.fingerprint ?? "未知"}（${hostKey?.keyType ?? "?"}）与 known_hosts 中记录的不同`,
      hint: recorded.length
        ? `已记录：${recorded.join(" ; ")}。若确认是服务器换了密钥，请手动更新 ~/.ssh/known_hosts；确认无误也可对该主机设 host_key_policy:"tofu"`
        : "该主机设为了 strict 策略但 known_hosts 中没有记录",
      attempted_methods,
      host_key_fingerprint: hostKey?.fingerprint,
    };
  }
  if (/Connection lost before handshake/i.test(msg)) {
    return {
      reason: `SSH 握手在完成前断开（${target.hostname}:${target.port}）`,
      hint: "该端口上可能不是 sshd，或中间设备把包吞了；先确认对端身份而不是重试",
      attempted_methods,
    };
  }
  if (/All configured authentication methods failed/i.test(msg)) {
    return {
      reason: `认证失败：${target.user}@${target.hostname}:${target.port} 拒绝了提供的凭据`,
      hint: triedKeys.length
        ? `已尝试本地私钥：${triedKeys.join(", ")}${target.password ? " + 密码" : "；未配置密码兜底（可在 config.local.json 或 SSH_MCP_PASSWORD 提供）"}`
        : "没有可用本地私钥，也没有密码；请在 config.local.json 里补 password 或 identity_files",
      attempted_methods,
    };
  }
  if (/no mutual signature algorithm/i.test(msg)) {
    return {
      reason: "密钥类型与服务器可协商的签名算法不匹配",
      hint: `本地私钥：${triedKeys.join(", ") || "无"}`,
      attempted_methods,
    };
  }
  if (/Timed out while waiting for handshake/i.test(msg)) {
    return {
      reason: `握手超时（${target.hostname}:${target.port}）`,
      hint: "确认地址与端口可达、防火墙未拦截；网络不可达时应先检查连通性而不是重试",
      attempted_methods,
    };
  }
  if (/ECONNREFUSED/.test(msg)) {
    return { reason: `连接被拒绝（${target.hostname}:${target.port} 未在监听）`, hint: "确认 sshd 状态与端口", attempted_methods };
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) {
    return { reason: `域名解析失败：${target.hostname}`, hint: "检查别名是否拼错；不传参数调用 ssh_run 可查看可用别名", attempted_methods };
  }
  return { reason: msg, attempted_methods };
}

/**
 * 建立连接。认证顺序：本地密钥优先（按 identity 候选顺序逐个尝试），
 * 失败后用密码兜底；两种路径都不会挂在交互式提示上。
 */
export async function connectTo(target: ResolvedTarget, opts: ConnectOptions = {}): Promise<ConnHandle> {
  const knownHosts = opts.knownHosts ?? KnownHostsStore.load();
  const keyCount = Math.max(target.privateKeys.length, 1);
  const configuredMethods: string[] = [];
  const attempted: string[] = [];
  const triedKeys: string[] = [];
  let lastErr: { err: Error; info: ConnectFailureInfo } | null = null;

  for (let i = 0; i < keyCount; i++) {
    const key = target.privateKeys[i];
    if (i > 0 && !key) break;
    const hkRef: { info: HostKeyInfo | null } = { info: null };
    const cfg = buildConnectConfig(
      target,
      i,
      knownHosts,
      (info) => {
        hkRef.info = info;
      },
      opts,
      (msg) => observeAuthAttempt(msg, attempted),
    );
    const methods = (cfg.authHandler as string[] | undefined) ?? [];
    if (key) triedKeys.push(key.path);
    for (const m of methods) if (!configuredMethods.includes(m)) configuredMethods.push(m);

    const result = await tryConnect(cfg);
    if (result.ok) {
      const reported = attempted.length ? attempted : configuredMethods;
      return {
        conn: result.conn,
        target,
        hostKey: hkRef.info ?? {
          status: "skipped",
          fingerprint: "",
          keyType: "",
          recorded: [],
        },
        authMethods: reported,
        ...(attempted.length ? { authSucceededWith: attempted[attempted.length - 1] } : {}),
        ...(key ? { identityOffered: key.path } : {}),
        close: () => result.conn.end(),
      };
    }
    lastErr = {
      err: result.err,
      info: describeConnectError(result.err, target, hkRef.info, triedKeys, attempted.length ? attempted : configuredMethods),
    };
    // 只有「认证失败」才值得换下一把 key；host key 拒绝和网络问题直接返回
    if (hkRef.info?.status === "mismatch") break;
    if (!/All configured authentication methods failed|no mutual signature algorithm/i.test(result.err.message)) {
      break;
    }
  }

  throw Object.assign(new Error(lastErr?.info.reason ?? "连接失败"), {
    connectFailure: lastErr?.info ?? { reason: "连接失败", attempted_methods: configuredMethods },
  });
}

function tryConnect(cfg: ConnectConfig): Promise<{ ok: true; conn: Client } | { ok: false; err: Error }> {
  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    const done = (r: { ok: true; conn: Client } | { ok: false; err: Error }) => {
      if (settled) return;
      settled = true;
      // 之后再来的 error 一律吞掉：连接已经判定失败，晚到的断开/协议错误不该冒泡成未捕获异常
      conn.on("error", () => {});
      resolve(r);
    };
    conn.once("ready", () => done({ ok: true, conn }));
    conn.once("error", (err: Error) => {
      try {
        conn.end();
      } catch {}
      done({ ok: false, err });
    });
    try {
      conn.connect(cfg);
    } catch (err) {
      done({ ok: false, err: err as Error });
    }
  });
}

/**
 * 打开 exec channel（无 PTY，stdout/stderr 两条独立流），并在通道建立的同一刻挂好监听。
 * 必须同步挂：命令极快退出时，ssh2 在 exec 回调所在的同一轮解析里就发出 exit/close，
 * 等 await 之后的微任务再挂监听已经错过了（实测 bash -n 的合法输入会这样，只能等到超时）。
 */
export function execAttached(
  conn: Client,
  command: string,
  env: Record<string, string>,
  attach?: (ch: ClientChannel) => void,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    conn.exec(command, { env: { TERM: "dumb", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...env } }, (err, stream) => {
      if (err) return reject(err);
      const ch = stream as unknown as ClientChannel;
      if (attach) attach(ch);
      resolve(ch);
    });
  });
}
