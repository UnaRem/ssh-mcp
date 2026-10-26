// known_hosts：解析、匹配（含 IPv6 与 [host]:port）、TOFU 追加与不匹配拒绝。
import { expect, test } from "bun:test";
import fs from "node:fs";

import { fingerprint, hostCandidates, keyTypeOf, KnownHostsStore } from "../src/knownhosts.ts";
import { tmpFile } from "./helpers.ts";

/** 造一个 wire format 的 host key blob（第一个字段是类型字符串，够本模块用） */
function blobOf(type: string, payload: string): Buffer {
  const t = Buffer.from(type, "utf8");
  const p = Buffer.from(payload, "utf8");
  const b = Buffer.alloc(8 + t.length + p.length);
  b.writeUInt32BE(t.length, 0);
  b.write(type, 4, "utf8");
  b.writeUInt32BE(p.length, 4 + t.length);
  b.write(payload, 8 + t.length, "utf8");
  return b;
}

const KEY_A = blobOf("ssh-ed25519", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const KEY_B = blobOf("ssh-ed25519", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

function line(spec: string, blob: Buffer): string {
  return `${spec} ${keyTypeOf(blob)} ${blob.toString("base64")}`;
}

test("fingerprint 与 keyTypeOf 取 blob 内容", () => {
  expect(keyTypeOf(KEY_A)).toBe("ssh-ed25519");
  expect(fingerprint(KEY_A)).toMatch(/^SHA256:[A-Za-z0-9_-]{43}$/);
  expect(fingerprint(KEY_A)).not.toBe(fingerprint(KEY_B));
});

 test("普通条目匹配：裸主机条目对所有端口生效", () => {
  const p = tmpFile("kh-plain.txt");
  fs.writeFileSync(p, [line("192.168.1.21", KEY_A), line("example.com", KEY_A)].join("\n") + "\n");
  const store = KnownHostsStore.load(p);

  expect(store.verify("192.168.1.21", 22, KEY_A).status).toBe("match");
  // OpenSSH 语义：裸主机条目对所有端口生效；[host]:port 条目才是端口限定的
  expect(store.verify("192.168.1.21", 2222, KEY_A).status).toBe("match");
  expect(store.verify("192.168.1.99", 22, KEY_A).status).toBe("unknown");
  expect(store.verify("192.168.1.21", 22, KEY_B).status).toBe("mismatch");
});

 test("[host]:port 条目只匹配该端口，不匹配默认端口", () => {
  const p = tmpFile("kh-port.txt");
  fs.writeFileSync(p, line("[192.168.1.21]:2222", KEY_A) + "\n");
  const store = KnownHostsStore.load(p);

  expect(store.verify("192.168.1.21", 2222, KEY_A).status).toBe("match");
  expect(store.verify("192.168.1.21", 22, KEY_A).status).toBe("unknown");
});

test("IPv6 条目用方括号形式，能正确匹配", () => {
  const p = tmpFile("kh-v6.txt");
  fs.writeFileSync(p, line("[2607:f130:0:152::a048:e094]", KEY_A) + "\n");
  const store = KnownHostsStore.load(p);
  expect(store.verify("2607:f130:0:152::a048:e094", 22, KEY_A).status).toBe("match");
  expect(store.verify("2607:f130:0:152::a048:e094", 22, KEY_B).status).toBe("mismatch");

  const q = tmpFile("kh-v6-port.txt");
  fs.writeFileSync(q, line("[2607:f130:0:152::a048:e094]:2222", KEY_A) + "\n");
  expect(KnownHostsStore.load(q).verify("2607:f130:0:152::a048:e094", 2222, KEY_A).status).toBe("match");
});

test("hostCandidates：22 端口只有裸地址，其他端口补 [host]:port", () => {
  expect(hostCandidates("h.example", 22)).toEqual(["h.example"]);
  expect(hostCandidates("h.example", 2222)).toContain("[h.example]:2222");
});

test("通配与否定模式、hashed 主机名", () => {
  const p = tmpFile("kh-pattern.txt");
  const salt = Buffer.from("01234567890123456789", "utf8");
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const hash = crypto.createHmac("sha1", salt).update("hidden.example").digest("base64");
  fs.writeFileSync(p, [
    line("*.lab.example", KEY_A),
    `|1|${salt.toString("base64")}|${hash} ${keyTypeOf(KEY_A)} ${KEY_A.toString("base64")}`,
    line("bad.example,!.sub.bad.example", KEY_A),
  ].join("\n") + "\n");
  const store = KnownHostsStore.load(p);

  expect(store.verify("web.lab.example", 22, KEY_A).status).toBe("match");
  expect(store.verify("hidden.example", 22, KEY_A).status).toBe("match");
  expect(store.verify("bad.example", 22, KEY_A).status).toBe("match");
  expect(store.verify("sub.bad.example", 22, KEY_A).status).toBe("unknown");
});

test("不匹配：报告已记录的指纹，且状态是 mismatch", () => {
  const p = tmpFile("kh-mismatch.txt");
  fs.writeFileSync(p, line("192.168.1.21", KEY_A) + "\n");
  const r = KnownHostsStore.load(p).verify("192.168.1.21", 22, KEY_B);
  expect(r.status).toBe("mismatch");
  expect(r.recorded.length).toBe(1);
  expect(r.recorded[0]).toContain(fingerprint(KEY_A));
});

test("TOFU：首次连接只追加一行，既有内容一字不改（含无末尾换行的情况）", () => {
  const p = tmpFile("kh-append.txt");
  const before = line("existing.example", KEY_A);
  fs.writeFileSync(p, before); // 故意不写末尾换行
  const store = KnownHostsStore.load(p);
  const { line: appended, created } = store.append("new.example", 22, KEY_B);

  const after = fs.readFileSync(p, "utf8");
  expect(created).toBe(false);
  expect(after.startsWith(before)).toBe(true);
  expect(after.split("\n").filter(Boolean)).toEqual([before, appended]);
  expect(store.verify("new.example", 22, KEY_B).status).toBe("match");
  fs.unlinkSync(p);
});

test("非 22 端口追加时用 [host]:port 写法", () => {
  const p = tmpFile("kh-append-port.txt");
  fs.writeFileSync(p, "");
  const store = KnownHostsStore.load(p);
  const { line: appended, created } = store.append("10.0.0.9", 2222, KEY_A);
  expect(created).toBe(true);
  expect(appended.startsWith("[10.0.0.9]:2222 ")).toBe(true);
  expect(store.verify("10.0.0.9", 2222, KEY_A).status).toBe("match");
  fs.unlinkSync(p);
});
