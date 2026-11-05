/**
 * 结果里的 hint：命令在「用 sleep 占住这次调用」时给一条改法提示。
 * 判据与 statefulHint 一样：能提示就不改行为，更不擅自把命令改成后台执行。
 * 阈值取 3 秒：3 秒以内的 sleep 通常是链式热身（起服务、等设备就绪），打扰它没有收益。
 */
import { describe, expect, test } from "bun:test";

import { statefulHint, waitHint } from "../src/tools/run.ts";

describe("waitHint：sleep 等待换成 nohup + 轮询", () => {
  test("轮询循环给出提示，并写清楚起后台的写法", () => {
    const h = waitHint(`for i in $(seq 1 40); do grep -q DONE job.log && break; sleep 5; done`);
    expect(h).toBeTruthy();
    expect(String(h)).toContain("nohup");
    expect(String(h)).toContain("tail -n");
  });

  test("单独一条长 sleep 也给提示", () => {
    expect(waitHint("sleep 20; tail -5 job.log")).toBeTruthy();
  });

  test("短 sleep（链式热身）与没有 sleep 都不打扰", () => {
    expect(waitHint("systemctl start app && sleep 2 && systemctl is-active app")).toBeUndefined();
    expect(waitHint("sleep 0.5 && cat out")).toBeUndefined();
    expect(waitHint("df -h /data")).toBeUndefined();
  });

  test("statefulHint 的原判定不受影响", () => {
    expect(statefulHint("cd /data/app")).toBeTruthy();
    expect(statefulHint("echo /data/app")).toBeUndefined();
  });
});
