// 主机解析测试：用临时配置做离线断言，不联网。
// 关键契约：未知主机必须报错并列出可用别名，而不是让模型猜地址（验收 2）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ResolveError, isIpLiteral, listHosts, resolveTarget } from "../src/config.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-cfg-"));
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["SSH_MCP_CONFIG", "SSH_MCP_SSH_CONFIG", "SSH_MCP_PASSWORD", "HOME", "USERPROFILE"];

function useConfigs(sshConfig: string | null, localConfig: string | null): void {
  if (sshConfig === null) delete process.env.SSH_MCP_SSH_CONFIG;
  else process.env.SSH_MCP_SSH_CONFIG = sshConfig;
  if (localConfig === null) delete process.env.SSH_MCP_CONFIG;
  else process.env.SSH_MCP_CONFIG = localConfig;
}

function writeNamed(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    // 把 home 指到空目录，避免测试读到本机 ~/.ssh
    if (k === "HOME" || k === "USERPROFILE") process.env[k] = dir;
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) process.env[k] = savedEnv[k];
});

describe("别名与直连地址解析", () => {
  test("读取 ~/.ssh/config 里的别名，包含 HostName/User/Port/IdentityFile", () => {
    const ssh = writeNamed(
      "ssh_config",
      [
        "Host los",
        "  HostName 2607:f130:0:152::a048:e094",
        "  User root",
        "  Port 22",
        "  IdentityFile ~/.ssh/unarem",
        "",
        "Host wildcard*",
        "  User nobody",
        "",
      ].join("\n"),
     );
     const emptyLocal = writeNamed("empty.json", JSON.stringify({ hosts: {} }));
     useConfigs(ssh, emptyLocal);

    const t = resolveTarget({ host: "los" });
    expect(t.alias).toBe("los");
    expect(t.hostname).toBe("2607:f130:0:152::a048:e094");
    expect(t.user).toBe("root");
    expect(t.port).toBe(22);
    expect(t.identityFiles).toEqual([path.join(dir, ".ssh", "unarem")]);
    expect(t.sources.some((s) => s.startsWith("ssh_config:"))).toBe(true);
    expect(t.hostKeyPolicy).toBe("tofu");

    // 通配别名不进入可用别名列表（无法直接当主机名用）
    expect(listHosts().aliases.map((a) => a.name)).toEqual(["los"]);
  });

  test("未知主机：报错并列出可用别名，同时提示可以用 IP", () => {
    const ssh = writeNamed("ssh_config2", "Host los\n  HostName 10.0.0.9\n  User root\n");
    const local = writeNamed("local2.json", JSON.stringify({ hosts: { lan: { hostname: "192.168.1.21" } } }));
    useConfigs(ssh, local);

    let caught: unknown;
    try {
      resolveTarget({ host: "typo-host" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ResolveError);
    const err = caught as ResolveError;
    expect(err.available.sort()).toEqual(["lan", "los"]);
    expect(err.hint).toContain("ssh_hosts");
  });

  test("user@host / host:port / [ipv6]:port 都能解析", () => {
    useConfigs(null, null);

    const a = resolveTarget({ host: "unarem@192.168.1.21" });
    expect(a).toMatchObject({ hostname: "192.168.1.21", user: "unarem", port: 22 });

    const b = resolveTarget({ host: "192.168.1.21:2222" });
    expect(b).toMatchObject({ hostname: "192.168.1.21", port: 2222 });

    const c = resolveTarget({ host: "root@[2001:db8::1]:2200" });
    expect(c).toMatchObject({ hostname: "2001:db8::1", user: "root", port: 2200 });

    const d = resolveTarget({ host: "10.0.0.5", user: "over", port: 2201 });
    expect(d).toMatchObject({ user: "over", port: 2201 });
  });

  test("isIpLiteral 区分 IP 与主机名", () => {
    expect(isIpLiteral("192.168.1.21")).toBe(true);
    expect(isIpLiteral("999.1.1.1")).toBe(false);
    expect(isIpLiteral("2001:db8::1")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isIpLiteral("lan")).toBe(false);
  });
});

describe("本地 profile 与凭据来源", () => {
  test("profile 提供密码与 identity_files，来源被记录", () => {
    const keyPath = path.join(dir, "key");
    fs.writeFileSync(keyPath, "not-a-real-key\n");
    const local = writeNamed(
      "local.json",
      JSON.stringify({
        hosts: {
          lan: {
            hostname: "192.168.1.21",
            user: "unarem",
            password: "s3cret",
            identity_files: ["~/key"],
            host_key_policy: "strict",
          },
        },
      }),
    );
    useConfigs(null, local);

    const t = resolveTarget({ host: "lan" });
    expect(t).toMatchObject({
      hostname: "192.168.1.21",
      user: "unarem",
      password: "s3cret",
      hostKeyPolicy: "strict",
    });
    expect(t.identityFiles).toEqual([keyPath]);
    expect(t.privateKeys.map((k) => k.path)).toEqual([keyPath]);
    expect(t.sources).toContain(`profile:${local}`);
  });

  test("SSH_MCP_PASSWORD 环境变量可作为密码兜底", () => {
    useConfigs(null, null);
    process.env.SSH_MCP_PASSWORD = "from-env";
    const t = resolveTarget({ host: "192.168.1.21" });
    expect(t.password).toBe("from-env");
  });

  test("本地配置不是合法 JSON 时报错并指出文件", () => {
    const bad = writeNamed("bad.json", "{ not json ");
    useConfigs(null, bad);
    expect(() => resolveTarget({ host: "10.0.0.1" })).toThrow(ResolveError);
  });

  test("listHosts 合并两个来源并标注来源", () => {
    const ssh = writeNamed("ssh_config3", "Host los\n  HostName 10.0.0.9\n  User root\n");
    const local = writeNamed(
      "local3.json",
      JSON.stringify({ hosts: { lan: { hostname: "192.168.1.21", user: "unarem" }, los: { user: "admin" } } }),
    );
    useConfigs(ssh, local);

    const h = listHosts();
    expect(h.aliases.map((a) => a.name)).toEqual(["lan", "los"]);
    expect(h.aliases.find((a) => a.name === "los")!.source).toEqual(["ssh_config", "config.local.json"]);
    expect(h.aliases.find((a) => a.name === "los")!.user).toBe("admin");
    expect(h.aliases.find((a) => a.name === "lan")!.hostname).toBe("192.168.1.21");
  });
});
