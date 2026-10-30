/**
 * 对外契约的参数片段。一条规则决定什么能出现在这里：
 *   只放 shell 给不了的东西。
 * 因此：
 * - 用户名、端口、host key 策略都不做参数 —— ~/.ssh/config 的 User/HostName/Port/StrictHostKeyChecking
 *   才是原生位置，或者用 user@ip 这种原生写法；
 * - 多步、取尾部、区间、过滤、写文件、建目录都是原生命令（&& / tail / sed / grep / heredoc / mkdir -p），
 *   不重造成 commands、output_mode 之类的参数；
 * - 只保留：目标主机、命令、跨调用的会话、超时与输出预算。
 * 文档写进 schema：默认值、取值范围、什么时候不要传，模型才不用猜。
 */
import { z } from "zod";

import { DEFAULT_MAX_OUTPUT_BYTES } from "./result.ts";
import { DEFAULT_EXEC_TIMEOUT_MS, MAX_COMMAND_CHARS, MAX_TIMEOUT_MS } from "./tool.ts";

export const hostArg = z
  .string()
  .min(1)
  .describe(
    "目标主机：~/.ssh/config 里的 Host 别名、config.local.json 里的名字，或原生写法 user@ip / ip / [v6]:port。" +
      "用户名与端口写在 ssh config（User/HostName/Port）或用 user@ip，没有额外的用户/端口参数。" +
      "不确定有哪些主机时，ssh_run 什么都不传就会把清单返回。",
  );

export const commandArg = z
  .string()
  .min(1)
  .max(MAX_COMMAND_CHARS)
  .describe(
    "原样交给远端 bash -lc 的一行命令，不做本地改写。多步用 && / ; / 管道；只看尾部用 tail -n；" +
      "看区间用 sed -n '120,180p'；过滤用 grep；写文件用 cat > f <<'EOF'；建目录用 mkdir -p。" +
      "这些都不需要额外参数：命令怎么写，远端就怎么跑。",
  );

/**
 * ssh_run 的 host/command 是可以都不传的：那时这次调用变成自省（返回主机清单与活动状态）。
 * 「该传什么」由 handler 判定并给出可操作说明，而不是靠 schema 的 required 一刀切。
 */
export const hostArgOpt = hostArg.optional();
export const commandArgOpt = commandArg.optional();

export const sessionArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "只有需要跨调用保持 cwd 与 export 时才传。取值写 keep：这台主机自动复用同一个 shell" +
      "（第一次调用时建立，结果返回 session_id，之后可以直接写这个 id；只有一个活动会话时连 host 都可以省）。" +
      "不传 = 一次性通道，本次命令里的 cd/export 不会带到下一次。",
  );

export const sessionOpArg = z
  .enum(["reset", "close"])
  .optional()
  .describe("配合 session 使用：reset=同一个 shell 回到登录初始目录；close=结束该会话（连接仍可复用）。与 command 互斥。");

export const cwdArg = z
  .string()
  .optional()
  .describe("建立会话时的起始工作目录（仅配合 session=keep 的新会话有效）。一次性调用请直接在命令里写 cd。");

export const envArg = z
  .record(z.string(), z.string())
  .optional()
  .describe("注入到该 shell 的环境变量（仅配合 session=keep 的新会话有效）。一次性调用请直接在命令里写 export。");

export const timeoutArg = z
  .number()
  .int()
  .min(100)
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(
    `命令超时毫秒，默认 ${DEFAULT_EXEC_TIMEOUT_MS}（上限 ${MAX_TIMEOUT_MS}）。超时是数据：结果里 timed_out=true，不算工具失败，` +
      "并且会带回超时之前已经产生的输出。注意桥不会终止远端命令——它只是停止等待，命令可能仍在远端跑；" +
      "要限制时长就在命令里写 timeout <秒> <命令>，长任务用 nohup ... >/dev/null 2>&1 &。",
  );

export const budgetArg = z
  .number()
  .int()
  .min(256)
  .max(1_000_000)
  .optional()
  .describe(
    `stdout/stderr 各自的字节预算，默认 ${DEFAULT_MAX_OUTPUT_BYTES}。超出会 truncated=true 并回报真实总字节与总行数；` +
      "想少看点就在命令里用 head/tail/sed，想拿完整文件就用 ssh_file 的 get。",
  );

/** 传输条目：SFTP 只做 shell 做不好的事 —— 二进制文件原样搬运。列目录/读文本都走原生命令。 */
export const transferEntryArg = z
  .object({
    op: z
      .string()
      .min(1)
      .describe('只能是 "put"（本机→远端）或 "get"（远端→本机）。列目录、看属性、读文本请用 ssh_run 的 ls / stat / sed。'),
    remote_path: z.string().min(1).describe("远端路径。~ 展开为远端用户家目录。"),
    local_path: z.string().min(1).describe("本机路径（绝对路径推荐）。~ 展开为本机家目录。get 时会按需创建父目录。"),
    overwrite: z.boolean().optional().describe("默认 false：目标已存在就报错，不静默覆盖。确认覆盖才传 true。"),
  })
  .strict();

export const entriesArg = z
  .array(transferEntryArg)
  .min(1)
  .max(32)
  .describe("一次调用传多个条目：同一条 SFTP 连接内按顺序完成，结果按请求顺序返回。单次最多 32 个。");
