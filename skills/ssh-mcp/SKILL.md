---
name: ssh-mcp
description: 要在远端 Linux 机器上做事时用这套桥：跑命令、看目录、查服务状态、读日志、排查部署问题都只用 exec（一行原生 shell，长任务后台化再轮询，跨调用保持 cwd/export 用 keep）；本机与远端之间搬文件只用 transfer。涉及远端/服务器/SSH/上线/日志/进程状态的任务优先用它，而不是本地 bash 或手写 ssh/scp。
---

# ssh-mcp：远端执行的用法与正反例

工具名在不同客户端可能带前缀（PI-Desktop 里是 `mcp_ssh_exec` / `mcp_ssh_transfer`）。
本文一律写 `exec` 和 `transfer`；语义与参数完全一致。

## 判断：用哪个，什么时候不用

- 远端 Linux 上做任何事 → `exec`（列目录、看属性、读文本、建目录也都是它的 `ls` / `stat` / `sed` / `mkdir -p`）。
- 本机 ↔ 远端搬文件（尤其是二进制、完整日志）→ `transfer`。
- 本机自己的事 → 用你本机的 shell 工具，不要用这两个。

## exec：一行原生命令，剩下的都是桥的事

命令原样交给远端 `bash -lc`，本地不改写。认证、host key、连接复用不用你操心：
`host` 只写 `~/.ssh/config` 别名或 `user@ip`，用户名和端口写在 config 里。
不知道有哪些主机：`exec` 什么都不传，返回主机清单与活动连接/会话。

**结果字段是数据不是报错**：`exit_code != 0`、`timed_out=true`、`truncated=true` 都正常返回，
带 stdout/stderr 与真实总量；只有桥自己出问题（连不上、认证失败、host key 变了）才是 error_code。

**时间预算只有一个数：5 秒，只能调小。** 5 秒回不来的活不要等——起后台、立刻返回 pid、短命令轮询。
超时后桥只是不再等，远端命令还在跑；要限制远端时长就在命令里写 `timeout 20 <命令>`。

### 反例 → 正例：最常见的用法错误

| ❌ 不要 | ✅ 换成 |
|---|---|
| `exec sleep 30 && tail job.log` 占住调用干等 | `nohup 长命令 > /path/job.log 2>&1 & echo $!` 立刻返回 pid，之后每次 `tail -n 50 /path/job.log` 或 `kill -0 <pid>` 轮询 |
| 给 `timeout_ms` 传 60000 想多等 | 只能调小；传大了被截到 5000 并回报 `timeout_capped`。长任务后台化 |
| 多步拆成 `cd app` + `git pull` 两次调用 | 一行写完：`cd app && git pull`（没有 session 时每次都是一次性通道） |
| 给一次性调用传 `cwd` / `env` | 直接在命令里写 `cd` / `export`；要跨调用保留才用 `session="keep"` |
| 想看日志最后几行，读回被截断的整个文件 | 命令里就过滤：`tail -n 200 app.log`、`grep -n error app.log`；要整个文件用 `transfer` 的 get |
| `transfer` 里写 `op:"list"` / `op:"read"` | 列目录 `exec ls -la`，看属性 `stat`，读文本 `sed -n '120,180p'`。`transfer` 只有 put/get |
| 先调一次「列主机」再干活 | 不干活时 `exec` 空参调用就是清单；干活时直接传别名 |

### 会话：跨调用保持状态

不传 `session` = 一次性通道，本次 `cd` / `export` 不留下。要连续在同一个目录里操作：

1. `exec host=node1 command="cd /srv/app && git status" session="keep"` —— 结果返回 `session_id`。
2. 之后写 `session="keep"`（同一主机自动复用）或直接写那个 id。只有一个活动会话时连 `host` 都能省。
3. 管理：`session="keep", session_op="reset"` 回到登录目录；`session_op="close"` 结束会话。
4. 会话空闲超过 TTL（默认 30 分钟）自动关闭，之后用旧 id 会报 `no_session` 并说明原因。

## transfer：只搬文件

`entries` 一次可多个（≤32，同一连接按顺序做），每条 `op` 只有两种：
`put` 本机→远端，`get` 远端→本机；`~` 两端都展开到家目录。
默认**不覆盖**已存在的目标，确认覆盖才 `overwrite=true`。
每条回报两端字节数与是否一致，本机侧另给 sha256——验证搬运结果就用这两个字段，别再 `md5sum` 一轮。

## 出错了看什么

`error_code` 是给下一步决策的：`auth_fail` 看 `auth_methods_attempted` 哪步断了；
`unresolved_host` / `dns_fail` 先空参调用核对别名；`host_key_changed` 是机器重装或换了 IP，
确认后再处理 known_hosts；`no_session` 说明会话已被 TTL 回收，重新 `keep` 即可。
首次见到的主机按 TOFU 自动记入 known_hosts（路径在结果的 `known_hosts_path`）；
要严格校验就设 `SSH_MCP_STRICT_HOST_KEY=ask` 并在客户端外维护该文件。
