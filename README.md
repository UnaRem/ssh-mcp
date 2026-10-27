# ssh-mcp

给 agent 用的 Linux 远端命令执行与文件传输工具：一个跑在 stdio 上的 MCP server。

对外只有一层「SSH 桥」，两个工具：

- **`ssh_run`** —— 在远端执行命令，拿结构化结果（退出码、stdout/stderr 分离、是否超时、是否截断、当前 cwd）；
- **`ssh_file`** —— 本地与远端之间搬文件（put/get，可批量，单条失败按数据返回）。

命令按原生 shell 写（`&&`、管道、`tail -n`、`sed -n`、heredoc、`mkdir -p`），桥只补 shell 给不了的东西：
认证与 host key 校验、连接复用、退出码与输出流的分离、输出预算与真实总量、跨调用的会话状态。
为什么这样切面、哪些不变量不能破，见 [`docs/domain.md`](docs/domain.md)；对外契约由 `test/contract.test.ts` 锁定。

技术栈：Bun + TypeScript + 官方 MCP SDK + [`ssh2`](https://github.com/mscdex/ssh2)。
不调用系统 `ssh`/`scp`/`sftp`/`plink` 子进程，不用 ControlMaster，除本 server 进程外不启动任何常驻后台进程。

## 特性

- **可判定的结果**：`exit_code`/`stdout`/`stderr` 分开返回；命令失败（退出码非 0）是数据不是工具错误，agent 能对结果做判定而不是猜。
- **窄工具面**：`tools/list` 恰好两个工具，参数只放 shell 给不了的东西；`ssh_run` 不传参数即自省——
  返回可用主机清单与来源、配置路径、活动连接与会话，省掉「先看有哪些主机」的那次调用。
- **快**：进程内连接池按 `user@host:port` 复用（新建连接 ~1.8s，复用后单条命令 5–60ms）；
  多步用 `&&` 合并成一次往返；`ssh_file` 一次传多个条目共用一条 SFTP 连接。
- **连续会话**：`session="keep"` 建立跨调用保持 cwd/环境的小 shell，按 TTL 自动回收，结束方式明确。
- **认证自动**：密钥优先、密码兜底；host key TOFU/严格/关闭三档；失败原因可读（尝试过哪些方法、实际指纹）。

## 安装与运行

要求 [bun](https://bun.sh)（本项目实测 bun 1.3.14；远端目标只支持 Linux）。

```bash
git clone https://github.com/UnaRem/ssh-mcp && cd ssh-mcp
bun install          # ssh2 的 cpu-features 原生模块会编译（约 30s）
```

三种运行方式，功能与验收完全一致：

| 方式 | 命令 | 适用 |
| --- | --- | --- |
| 源码直跑 | `bun run src/index.ts` | 开发期（改代码即生效） |
| 本地构建产物 | `bun run build` → `dist/ssh-mcp.exe` | 对端不装 bun 也能用 |
| 下载发布产物 | GitHub Release 的 `ssh-mcp-<版本>-windows-x64.zip`（解压即 `ssh-mcp.exe`） | 不想碰仓库 |

本机的固定安装位是 `~/tools/ssh-mcp.exe`（`C:/Users/UnaRem/tools/`），与仓库位置解耦：

```bash
bun run build
cp dist/ssh-mcp.exe ~/tools/
bun run dist-verify                    # 对安装位跑 11 项端到端验收
```

> 覆盖前先退出 MCP 客户端：客户端正持着这个 exe 时 Windows 不让写（`Device or resource busy`）。
> 产物必须过 `dist-verify`：`--compile` 把依赖（含原生模块）打进单文件，构建期不报错不代表运行期没问题。

### 新机器上的配置

凭据不在产物里（zip 只有 exe；`config.local.json` 含明文密码，永不入库）。配置文件放哪都行，靠环境变量指过去，
查找顺序只有两条：`SSH_MCP_CONFIG`（用这条，绝对路径）→ 兜底 `<server 进程 cwd>/config.local.json`（客户端的 cwd 不可靠，别依赖）。

1. 解压 exe 到固定位置（如 `~/tools/ssh-mcp.exe`）；
2. 写配置：从旧机器拷 `config.local.json`，或照仓库的 `config.example.json` 写一份；
   建议放 exe 同目录（如 `~/tools/ssh-mcp.config.json`），迁移时整目录拷走；
3. 客户端 MCP 配置里两条绝对路径：`command` → exe，`env.SSH_MCP_CONFIG` → 配置文件；
4. 验证：调 `ssh_run({})`（自省模式），返回的 `hosts` 清单正确、`local_config_exists: true` 即通。

host key 记录是每台机器自己的（`~/.ssh/known_hosts`，TOFU 首连自动记录）；要复用旧机器的信任记录就拷贝该文件
或设 `SSH_MCP_KNOWN_HOSTS`。新机器上若存在 `~/.ssh/config`，其别名会被自动读取，不必在 profile 里重复登记。

## 接入 MCP 客户端

所有客户端的配置形状相同，`command` 指向源码（经 bun）或 exe 都可以。用绝对路径——客户端的工作目录不确定。

```json
{
  "mcpServers": {
    "ssh": {
      "command": "bun",
      "args": ["run", "C:/absolute/path/to/ssh-mcp/src/index.ts"],
      "env": { "SSH_MCP_CONFIG": "C:/absolute/path/to/ssh-mcp/config.local.json" }
    }
  }
}
```

- `command` 建议用 bun 的绝对路径（如 `C:/Users/<you>/.bun/bin/bun.exe`），免受 GUI 进程 PATH 差异影响。
- `SSH_MCP_CONFIG` 必须是绝对路径：配置文件不在产物里（含明文密码，永不入库），
  不显式给会退回「进程 cwd 下的 `config.local.json`」，而客户端的 cwd 不可靠。

### 工具叫什么名字（两类客户端不同）

客户端可见的工具名 = 客户端侧命名空间 + 工具原名，命名空间的来源各客户端不同：

- **PI-Desktop**（配置在 `~/.pi/agent/mcp.json`）：前缀是 `mcp_` + 服务端身份名 + `_`，
  身份名取 `src/index.ts` 的 `new McpServer({ name: "ssh" })`，改客户端配置的键不影响它。
  本项目刻意把身份名取短且不与工具名的 `ssh_` 段交错重复（`ssh-mcp` 会得到 `mcp_ssh_mcp_ssh_run`，模型容易写错）。
  **如果以前登记过旧身份（如 `ssh-mcp`），删掉那条旧条目**，否则同一个 server 注册两份、工具目录翻倍。
- **OpenCode**（`~/.config/opencode/opencode.json`）：命名空间是它配置里的 mcp 键（本机登记为 `ssh-tool`），
  不读服务端身份名；改键即时热重载。

### 改配置/换版本后，工具目录何时刷新

改客户端配置或换了 server 的工具面之后，已建立的连接不会自动重建工具目录：

- **PI-Desktop**：完整退出并重启进程（只重连 server 无效），或在适配器里 `mcp({ connect: "server" })` 重新发现。
- **OpenCode**：MCP 连接按目录建立，改配置只重建部分目录的连接，已建立的那条名字带行为都停在旧版本。
  刷新靠 `opencode service restart`（连接活在常驻 `serve --service` 进程里，只关 TUI 无效），
  或重建该目录的实例。`opencode mcp` 没有 reload 子命令。
  自检：`ssh_run({})` 返回里带 `mode:"inventory"` 与 `hint` 才是新工具面。

协议层验收不受客户端缓存影响：`bun run live` / `bun run dist-verify` 走真实 stdio 握手与 `tools/call`。

### 让客户端检索得到工具

很多客户端靠词法匹配 `name`/`description` 决定是否把工具加载进上下文，而且**分词通常只保留 ASCII**——
纯中文 description 等于没有。服务端已处理：每个工具 description 末尾带 ASCII `Keywords:`，server 另带
`instructions` 说明何时用哪个工具（这是对外契约的一部分，契约测试会断言）。

部分客户端还支持侧配置（如 PI-Desktop 的 `mcp.json` 里该 server 下加 `searchKeywords`，按工具名给关键词），
只影响排序、不展示给模型。客户端侧配置由使用侧自己维护，本仓库不代改。

### 参数校验发生在哪一层

发布的 JSON Schema 带 `additionalProperties:false`（服务端 `z.object(...).strict()`），越界参数会被点出键名。
但注意有的客户端（如 OpenCode）发送前会先按 schema 校验一遍：缺字段直接报错、多余的键**静默剥掉**。
排查「参数没生效」时先分清错误来自客户端还是服务端协议层；两边的边界一致，模型从 schema 就能看见。

## 主机与认证

### 主机解析顺序

`host` 参数按以下顺序解析，任一命中即可；解析不出来会报错并**列出全部可用别名**（不让模型猜 IP）：

1. `config.local.json` 里的 profile（见下）；
2. `~/.ssh/config` 的别名（读 `HostName`/`User`/`Port`/`IdentityFile`；`ProxyJump` 等跳转不跟随）；
3. 直接写 `192.168.1.21` / `user@192.168.1.21` / `host:2222` / `user@[v6]:2222`。

`ssh_run` 不传参数就能拿到两处的别名与来源（`source` 字段），以及当前活动连接与会话。

### 本地 profile

复制 `config.example.json` 为 `config.local.json`（已被 `.gitignore` 忽略，含密码的文件永不入库）：

```json
{
  "defaults": { "host_key_policy": "tofu" },
  "hosts": {
    "lan": {
      "hostname": "192.168.1.21",
      "user": "unarem",
      "password": "……"
    },
    "app": {
      "hostname": "10.0.0.5",
      "user": "deploy",
      "identity_files": ["~/.ssh/id_ed25519"],
      "host_key_policy": "strict"
    }
  }
}
```

字段：`hostname` `port` `user` `password` `key_passphrase` `identity_files` `host_key_policy`（`tofu`/`strict`/`off`）。
`defaults` 会被具体 profile 覆盖。

### 认证：密钥优先，密码兜底

- 有可用私钥（`identity_files`、`~/.ssh/config` 指定的、或 `~/.ssh/` 下的 `id_*`）时先试 publickey，失败再试密码
  （显式 `authHandler: ["publickey","password"]`；ssh2 默认顺序是密码在前）。
- 密码来源优先级：`config.local.json` 的 `password` → 环境变量 `SSH_MCP_PASSWORD_<别名大写、非字母数字换下划线>` → `SSH_MCP_PASSWORD`。
- 绝不弹交互密码提示：拿不到凭据就在 `SSH_MCP_READY_TIMEOUT_MS` 内失败，原因可读。
- 返回里的 `auth_methods_attempted` / `auth_succeeded_with` 来自 SSH 协议报文实测，不是猜的。

### host key

`ssh2` 本身不校验 host key，这里自己实现，`known_hosts` 只**追加**、不改写既有行：

| 策略 | 行为 |
| --- | --- |
| `tofu`（默认） | 首次连接记录，之后不匹配就拒绝（错误里带实际指纹） |
| `strict` | 没有记录就拒绝 |
| `off` | 不校验 |

支持裸 host（对所有端口生效）、`[host]:port`（仅该端口）、IPv6 方括号、通配与 `!` 排除、`|` 哈希条目。
`SSH_MCP_KNOWN_HOSTS` 可指定别的文件（默认 `~/.ssh/known_hosts`）。

### 凭据的威胁模型

**约束：密码/私钥不得暴露在公网——禁止用密码或私钥凭据直连公网可达的主机（公网 IP / 域名）。**
所有目标主机必须是公司局域网或异地组网内、网络层不可从公网抵达的：明文密码只存在于本地 config 与内网链路；
即使口令被第三方模型 API 读到，网络层也抵达不了服务器，泄露不构成可兑现的损失。
因此不做凭据托管类扩展（公钥自动注册、桥代持/代问 sudo 口令、elicitation）。
要把公网主机纳管：先组网（VPN/内网穿透后按局域网对待），而不是放宽这条约束。

## 工具与返回语义

### ssh_run

| 参数 | 说明 |
| --- | --- |
| `host` | 别名 / `user@ip` / `host:port`（自省模式可不传） |
| `command` | 一条原生 shell 命令；不传且无 `session_op` 时是自省模式 |
| `session` | `keep`（新建并复用）或之前返回的 `session_id`；只有一个活动会话时可省 `host` |
| `session_op` | `reset`（回登录目录）/ `close`（结束会话），与 `command` 互斥 |
| `cwd` `env` | 一次性生效的工作目录/环境变量（要跨调用保持就用会话，返回里 `hint` 会说明） |
| `timeout_ms` `max_output_bytes` | 本次调用的超时与输出预算上限 |

返回：`ok` `exit_code` `stdout` `stderr` `cwd` `timed_out` `truncated` + 真实总量（`stdout_bytes`/`stdout_lines`）
+ 连接元信息（`connection`、`auth_*`、`host_key`）；会话调用带 `session_id`。

自省模式（不传参数）返回：`mode:"inventory"`、`hosts` 清单与来源、配置路径、`active_connections`、`active_sessions`。

### ssh_file

| 参数 | 说明 |
| --- | --- |
| `host` | 同上 |
| `entries[]` | 每条目：`op`（`put`/`get`）、`remote_path`、`local_path`、`overwrite`（默认 false，目标已存在报 `exists`） |

按请求顺序返回每个条目：`bytes_match`、两端字节数、`sha256_local`；单条失败带该条的 `error_code`，其余条目照常执行。
`~` 经 `realpath` 展开为远端家目录。多条目共用一条 SFTP 连接。

### 用法要点

- **多步、取尾部、区间、过滤、写文件、建目录都写在命令里**：`mkdir -p a && cd a && pwd`、
  `journalctl -u app | tail -n 50`、`sed -n '120,180p' f`、`cat > f <<'EOF' … EOF`。
  没有 `commands[]`、`output_mode`、`tail_lines` 这类参数——那是把 shell 的能力重新发明一遍。
- **用户名/端口/host key 策略不是参数**：写在 `~/.ssh/config` 或用 `user@ip`，或放在 `config.local.json`。

### 返回语义

- 成功调用：`ok: true` + JSON（同时给 `structuredContent`）。**命令退出码非 0 不是工具错误**：
  `isError=false`、顶层 `ok=false`，看 `exit_code` 与 `stderr` 判定。
- 工具错误：`isError=true` + `error_code` + 可操作的 `error`，并附上补救所需的事实。

| error_code | 何时 | 附带事实 |
| --- | --- | --- |
| `bad_input` | 缺 `command`、`session_op` 与 `command` 同时给、`op` 不是 put/get、越界参数 | `allowed_ops`、`active_sessions` |
| `unknown_host` | 别名解析不出来 | `available_hosts`、两处配置路径 |
| `connect_failed` / `auth_failed` / `host_key_mismatch` | 握手 / 凭据 / host key | `hint`、`attempted_methods`、`host_key_fingerprint` |
| `no_session` | 会话不存在、被 TTL 回收，或只凭 `keep` 找不到可复用 shell（缺 `host` 的说明写在 `error` 里）——「会话不存在」只有这一种错误码 | `active_sessions`、空闲时长与 TTL |
| `not_found` / `permission` / `exists` | 传输条目的文件系统情形（**按数据返回，调用本身不是错误**）；`exists` 判**目标**侧且先于源检查 | 条目 `index`、路径 |
| `internal` | 其它未归类 | `error`、`cause` |

### 行为保证

- `timeout_ms` 到期 → `timed_out: true`，server 与连接都还活着；
- 输出超预算 → `truncated: true`，并回报真实总量；想少看点就在命令里用 `head`/`tail`/`sed`；
- 一次性调用默认给命令补 `< /dev/null`（`cat` 不会挂死）；管道命令不补，以免改变语义；
- 引号未闭合等语法错误先过远端 `bash -n` 预检，返回「命令未执行」+ bash 的报错，命令不会半执行；
- 后台进程占住 fd → 哨兵超时后返回 `background_suspect: true` 并自动重开会话；
- 会话空闲超 TTL 自动关闭，下次用该 id 会说明原因与时长，并提示 `session="keep"` 重新开始。

## 环境变量（都有默认值）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `SSH_MCP_CONFIG` | `<cwd>/config.local.json` | 本地 profile 文件（客户端里务必给绝对路径） |
| `SSH_MCP_SSH_CONFIG` | `~/.ssh/config` | 覆盖 ssh_config 路径（测试用） |
| `SSH_MCP_KNOWN_HOSTS` | `~/.ssh/known_hosts` | known_hosts 路径 |
| `SSH_MCP_PASSWORD` / `SSH_MCP_PASSWORD_<ALIAS>` | — | 密码兜底 |
| `SSH_MCP_READY_TIMEOUT_MS` | 12000 | 握手/认证等待上限 |
| `SSH_MCP_EXEC_TIMEOUT_MS` | 30000 | 命令默认超时（工具可覆盖，上限 600000） |
| `SSH_MCP_SESSION_TTL_MS` | 600000 | 会话空闲 TTL |
| `SSH_MCP_CONN_TTL_MS` | 300000 | 进程内连接池空闲 TTL |

## 开发与验收

```bash
bun run lint                                     # = bunx tsc --noEmit
bun test                                         # 离线测试，不需要网络（fake 替身 + 进程内真 SSH 服务器）
bun run live                                     # 对真实主机 25 项端到端验收，读 config.local.json
bun run build                                    # 单文件产物 dist/ssh-mcp.exe
bun run dist-verify                              # 对产物 11 项验收，默认 ~/tools/ssh-mcp.exe
bun run dist-verify dist/ssh-mcp.exe --offline   # 只跑协议层 5 项（CI 用，远端相关记 SKIP）
```

`live` 会复制一份 `~/.ssh/known_hosts` 到临时目录来跑 TOFU/不匹配用例，不动真实文件，跑完清理远端临时目录。
分层：`test/contract.test.ts` 锁对外契约（两个工具、参数集合恰好等于声明、错误码、自省模式、ASCII `Keywords:`、
版本与 `package.json` 一致）；其余单测按模块对应（会话/连接/SFTP/配置）。
**改对外面先改契约测试（红）再实现（绿）**——`docs/domain.md` 与契约测试是同一结论的两处，必须同步改。
改完 `src/**` 的远端行为，收官跑一次 `bun run live`；改完 `bun run build`，必须跑 `bun run dist-verify`。

## 发布

只发 windows-x64 单文件产物，push 驱动：

1. 把 `package.json` 的 `version` 改一行，提交并 push 到 `main`；
2. GitHub Actions（`.github/workflows/release.yml`）：版本号没发过才继续——
   lint + 离线测试 → `--target=bun-windows-x64` 编译 → `dist-verify --offline` 自检 →
   在该 commit 创建 `v<版本>` tag → zip（约 37 MiB，exe 96 MiB 逼近单资产上限）挂到 Release，
   Release 说明由 commit 历史生成；版本号没改的 push 整段跳过。

版本号只写在 `package.json` 一处（`src/tool.ts` 读它，契约测试断言 `serverInfo.version` 一致，tag 由 CI 创建），
保证 tag ↔ commit ↔ 二进制三者对应。要发其它平台就新增一个 job，前提是先在该平台的 CI 里跑通产物自检。

## 边界（明确不做）

- 只支持 Linux 远端；不做 Windows 远端语义适配。
- 不启用 ControlMaster/ControlPersist，不引入系统 ssh 子进程或 plink 后端；不留任何常驻后台进程。
- 不做后台任务/job 家族（异步任务表、轮询取结果）。
- 不把 SFTP 的 list/stat/read/write/mkdir 做成工具：远端 `ls`/`stat`/`sed`/`cat`/`mkdir -p` 更贴近模型既有能力。
- 不做凭据托管类扩展（公钥自动注册、桥代持/代问 sudo 口令、elicitation）——理由见「凭据的威胁模型」。
- 禁止用密码/私钥凭据直连公网可达的主机：凭据不得暴露在公网，公网主机先组网再纳管。
- 不做 npm 发布 / Docker / Web UI / 遥测；对外分发只有上面的单文件产物。
- 不读写 `~/.ssh/config`，不改写私钥；对 `known_hosts` 仅追加。

## License

[MIT](LICENSE)
