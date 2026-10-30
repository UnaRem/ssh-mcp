# 领域模型（对外契约的根据）

这份文件回答「为什么参数长这样」，不是用法手册（用法在 README 与各工具的 schema description 里）。
改 `src/tools/*`、`src/schema.ts`、`src/envelope.ts` 之前先读这里；`test/contract.test.ts` 锁的就是这里的结论。

## 1. 判据：桥只补 shell 给不了的东西

一条规则决定对外面与参数的边界：

- **远端 bash 自己就能做到的，一律透传，不重造成参数。**
  多步用 `&&`/`;`/管道；只看尾部用 `tail -n`；区间用 `sed -n 'a,bp'`；过滤用 `grep`；
  写文件用 `cat > f <<'EOF'`；建目录用 `mkdir -p`。模型本来就会写这些命令，
  再造一套 `commands[]`/`output_mode`/`tail_lines` 只会增加出错面（实测：模型写错自造参数的概率远高于写错 shell）。
- **shell 给不了的，才是桥的职责**：认证与 host key 校验、连接复用、退出码与 stdout/stderr 分离、
  输出预算与真实总量、跨调用的会话状态、本机与远端之间的二进制搬运。
- **用户名、端口、host key 策略不是参数**：它们的原生位置是 `~/.ssh/config` 的
  `User`/`HostName`/`Port`/`StrictHostKeyChecking`，或 `user@ip` 这种原生写法。
  在工具上再开一份就等于两处真值。

因此对外只有两个工具：`ssh_run`（执行）与 `ssh_file`（搬文件）。多一个工具就是契约漂移，
`test/contract.test.ts` 会失败。

## 2. 统一语言

| 术语 | 含义 | 代码位置 |
| --- | --- | --- |
| Target（目标） | 一次调用解析出的连接目标：别名→host/port/user/凭据/来源链 | `config.ts: ResolvedTarget` |
| Connection（连接） | 一条 SSH 连接，进程内按 `user@host:port` 复用，带 host key 校验结果 | `backend.ts: ConnHandle`、`index.ts: pool` |
| ExecAttempt（一次执行） | 命令的一次尝试：exit_code、stdout/stderr 分离、是否超时、是否截断、cwd | `types.ts: ExecResult` |
| ShellSession（会话） | 跨调用保持 cwd 与 export 的远端 shell，哨兵协议判定边界，空闲超 TTL 回收 | `session.ts: ShellSession/SessionManager` |
| Transfer（传输） | 本机与远端之间原样搬一个文件，带两端字节数与 sha256 | `sftlops.ts: sftpPut/sftpGet` |
| Error code（错误码） | 可枚举的失败类别；与「命令失败」严格区分 | `envelope.ts: ErrorCode` |
| Inventory（自省） | 不传参数时返回的主机清单、配置来源、活动连接与会话 | `index.ts: inventory()` |

## 3. 不变量（违反即 bug）

1. **一次调用至多新建一条连接。** 连接池按 `user@host:port` 复用；结果里必须回报
   `connection: "new" | "reused"`。任何让「一次调用多次建连」的改动都是回归（新连接实测 ~1.8s）。
2. **命令失败是数据，不是工具错误。** `exit_code != 0` → `isError=false`，但顶层 `ok=false`
   （包装器 `ok()` 不得把工具自己给的 `ok:false` 抹平）。单条传输失败同理：条目带 `error_code`，
   其余条目照常完成。
3. **工具错误必须带 `error_code`。** 参数/解析/连接/会话/文件系统类错误 → `isError=true` +
   枚举错误码 + 可操作的 `error` 文案 + 补救所需的事实（未知主机回 `available_hosts`，
   未知会话回 `active_sessions`，认证失败回 `attempted_methods`）。
4. **出错不动连接池。** 参数错误与连接无关；把可疑连接的摘除交给 ssh2 的 `close`/`error` 事件与
   取用时的 TTL 判定。（实测教训：无条件 `dropHost` 曾让一次 `op` 写错的 `ssh_file` 调用杀掉同主机的 keep 会话。）
5. **参数集合是硬契约。** 发布的 JSON Schema 带 `additionalProperties: false`（`z.object(...).strict()`）：
   多余参数被立刻拒绝而不是被 SDK 静默剥掉。工具属性集合变化必须同步改 `test/contract.test.ts`。
6. **工具描述末尾必须带 ASCII `Keywords:`。** 客户端的工具检索按 ASCII 分词，中文不参与匹配，
   没有关键词等于模型找不到这个工具。
7. **除 server 进程外不留常驻进程。** 退出时关闭连接与会话；测试会确认子进程真的消失。
8. **含明文密码的只有 `config.local.json`**，必须保持被 gitignore；密码永不写入任何入库文件。
9. **超时也是数据，且结果必须自解释。** `timed_out=true` 时三件事缺一不可：
   已到达的输出必须原样带回（放弃这条管道时要 flush 帧预留区，否则短命令超时后 `stdout` 必为空——实测 2026-10-30）；
   说明桥**只是停止等待**，关闭通道不会终止远端命令（实测 2026-10-30，OpenSSH 9.6p1：被放弃的 `sleep 12; touch f`
   仍跑完并创建了文件），所以不许写「命令已终止」；
   并给出把时长变可控的原生做法（命令里 `timeout <秒> …`、`nohup … &`、显式 `timeout_ms`）。
   锁它的测试：`test/session.test.ts`、`test/exec.test.ts`、`scripts/live-verify.ts` 的 A9。

## 4. 分层与边界

```
src/tools/{run,file}.ts   对外契约：shape（参数）+ handler（用例编排）
        ↓ 只经 BridgeCtx
src/bridge.ts             边界类型：BridgeCtx / Acquired / ToolDef / runOptions
        ↓
src/index.ts              装配：配置与超时、连接池、会话登记、自省、错误映射、注册中间件
        ↓
config / backend / session / exec / sftlops / knownhosts / result   内部上下文，不直接对外
```

- 工具层**不 import** 实现模块的连接池与会话登记，只经 `BridgeCtx` 取用（`acquire`/`sessions`/`openSftp`/`inventory`）。
  这样「对外只有一层桥」是可检查的，而不是靠约定。
- `schema.ts` 只放参数片段与其文档；默认值、取值范围、「什么时候不要传」都写进 description。
- `envelope.ts` 是失败侧的唯一出口：`BridgeError` / `bridgeError()` 抛，`fromError()` 统一映射成
  带 `error_code` 的结构化结果。

## 5. 错误码语义

| error_code | 何时 | 附带事实 |
| --- | --- | --- |
| `bad_input` | 缺 command、`session_op` 与 `command` 同时给、`op` 不是 put/get、`cwd/env` 未配会话、多余参数 | `allowed_ops`、`active_sessions`、schema 的 `additionalProperties:false` |
| `unknown_host` | 别名解析不出来 | `available_hosts`、`ssh_config_path`、`local_config_path` |
| `connect_failed` | TCP/KEX/握手/解析失败 | `hint`、`attempted_methods` |
| `auth_failed` | 凭据被拒 | `attempted_methods`、`identity_offered` |
| `host_key_mismatch` | known_hosts 与服务器密钥不符 | `host_key_fingerprint`、已记录条目 |
| `no_session` | 会话不存在或已被 TTL 回收；也包括只凭 `keep` 找不到任何可复用的 shell（此时缺 host 的说明写进 `error`） | `active_sessions`、`idle_ms`/`ttl_ms` |
| `not_found` / `permission` / `exists` | 传输条目对应的文件系统情形（**按数据返回，不是工具错误**） | 条目 `index`、路径 |
| `internal` | 其它未归类 | `error`、`cause` |

## 6. 明确不做

- 后台任务/job 家族（异步任务表、轮询取结果）——与「不留常驻进程」的边界冲突，已取消。
- 把 SFTP 的 list/stat/read/write/mkdir 做成工具——远端 `ls`/`stat`/`sed`/`cat`/`mkdir -p` 更贴近模型既有能力。
- Windows 远端语义、ControlMaster、系统 `ssh` 子进程、npm 发布、Docker、Web UI。
- 凭据托管类扩展（公钥自动注册「ssh-copy-id 化」、桥代持/代问 sudo 口令、elicitation 要密码）——不做。
  威胁模型（用户定，2026-10-27）：目标主机限定在公司局域网/异地组网，明文密码只存在于本地 config 与内网链路；
  即使口令被第三方模型 API 读到，网络层也抵达不了服务器，泄露不构成可兑现的损失。
  凭据的保管由用户自己控制：config.local.json 明文与 `SSH_MCP_PASSWORD_*` 环境变量两条既有通道已够。
  硬约束：**密码/私钥不得暴露在公网——禁止用密码/私钥凭据直连公网可达的主机**；
  公网主机要先组网（VPN/内网穿透）再纳管，不放宽这条约束，也不为它做凭据托管。
