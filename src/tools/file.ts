/**
 * ssh_file：桥的第二个工作闭环——本机与远端之间搬文件。
 *
 * 只做 shell 做不好的事：二进制文件原样搬运（put/get），带大小校验与 sha256。
 * 列目录、看属性、读文本、建目录一律走 ssh_run 的 ls / stat / sed / cat / mkdir -p，
 * 因为那些命令模型本来就会写，再造一套参数只会增加出错面。
 * 一次调用在同一条 SFTP 连接里按顺序完成多个条目（每个条目都是一个 RTT）。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";

import type { BridgeCtx, ToolDef } from "../bridge.ts";
import { bridgeError, classifyMessage } from "../envelope.ts";
import { entriesArg, hostArg } from "../schema.ts";
import { expandTilde } from "../result.ts";
import * as sftlops from "../sftlops.ts";

interface Entry {
  op: string;
  remote_path: string;
  local_path: string;
  overwrite?: boolean;
}

const ALLOWED_OPS = ["put", "get"];

function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export const fileTool: ToolDef = {
  name: "ssh_file",
  title: "本机与远端之间传文件",
  description:
    "在本地与远端之间原样搬运文件：op=put 是本机→远端，op=get 是远端→本机。默认不覆盖已存在的目标，确认覆盖传 overwrite=true。" +
    "一次可以传多个条目，它们共用一条 SFTP 连接并按请求顺序返回结果；每条都回报两端字节数与是否一致，本机文件另给 sha256。" +
    "列目录、看属性、读文本、建目录请改用 ssh_run（ls / stat / sed -n / cat / mkdir -p），不要用这里的参数。",
  keywords:
    "Keywords: sftp upload download file transfer send fetch remote file binary sha256 overwrite " +
    "copy to server copy from server size verify",
  shape: { host: hostArg, entries: entriesArg },
  handler: async (ctx: BridgeCtx, raw: Record<string, unknown>) => {
    const a = raw as { host?: string; entries?: Entry[] };
    if (!a.host) {
      bridgeError("bad_input", "缺少 host：传 ~/.ssh/config 里的别名或 user@ip（ssh_run 不传任何参数会返回主机清单）。");
    }
    const entries = Array.isArray(a.entries) ? a.entries : [];
    if (entries.length === 0) {
      bridgeError("bad_input", 'entries 至少一个条目，形如 [{"op":"get","remote_path":"/var/log/app.log","local_path":"./app.log"}]。');
    }
    // op 写错是用法错误，整次调用都不执行：与其返回一堆半成品结果，不如一次说清楚
    const bad = entries.findIndex((e) => !ALLOWED_OPS.includes(String(e.op)));
    if (bad >= 0) {
      bridgeError(
        "bad_input",
        `entries[${bad}].op="${String(entries[bad]!.op)}" 不行：只能是 put（本机→远端）或 get（远端→本机）。` +
          "列目录用 ssh_run 的 ls -la，看属性用 stat，读文本用 sed -n 'a,bp'，建目录用 mkdir -p。",
        { bad_index: bad, allowed_ops: ALLOWED_OPS },
      );
    }

    const acquired = await ctx.acquire({ host: a.host! });
    const sftp = await ctx.openSftp(acquired.conn);
    const results: Record<string, unknown>[] = [];
    try {
      for (const [index, e] of entries.entries()) {
        const started = Date.now();
        const local = expandTilde(e.local_path);
        const base = { index, op: e.op, remote_path: e.remote_path, local_path: local };
        try {
          if (e.op === "put") {
            const r = await sftlops.sftpPut(sftp, local, e.remote_path, e.overwrite === true);
            results.push({ ...base, ok: true, duration_ms: Date.now() - started, ...r, sha256_local: sha256File(local) });
          } else {
            const r = await sftlops.sftpGet(sftp, e.remote_path, local, e.overwrite === true);
            results.push({ ...base, ok: true, duration_ms: Date.now() - started, ...r, sha256_local: sha256File(local) });
          }
        } catch (err) {
          // 单个条目失败是数据：其它条目照常完成，调用方按 error_code 决定下一步
          const message = err instanceof Error ? err.message : String(err);
          results.push({ ...base, ok: false, duration_ms: Date.now() - started, error_code: classifyMessage(message), error: message });
        }
      }
    } finally {
      sftp.end();
    }

    const failed = results.filter((r) => r.ok !== true).length;
    return {
      ok: failed === 0,
      entries: results,
      total: results.length,
      failed,
      size_limit_bytes: sftlops.MAX_TRANSFER_BYTES,
      ...(failed > 0
        ? { hint: "失败的条目在 entries 里按原顺序返回，带 error_code。已存在就改 overwrite=true 或换路径；远端不存在先确认路径。" }
        : {}),
      ...ctx.connMeta(acquired),
    };
  },
};
