# ssh-mcp —— 给 agent 用的 SSH/SFTP 工具

一个 stdio 上的 MCP server，让 agent 用**尽量少的调用**在 Linux 远端执行命令、传文件，
并拿到**结构化、可判定**的结果：退出码、stdout/stderr 分离、是否超时、是否截断、当前 cwd。

对外只有一层「SSH 桥」：**`ssh_run`（跑命令）+ `ssh_file`（搬文件）**。
命令按原生 shell 写（`&&`、管道、`tail -n`、`sed -n`、heredoc、`mkdir -p`），
桥只补 shell 给不了的东西（认证与 host key、连接复用、退出码分离、输出预算、跨调用的会话状态）。
为什么这样切、哪些不变量不能破，见 `docs/domain.md`。

技术栈：Bun + TypeScript + 官方 MCP SDK + [`ssh2`](https://github.com/mscdex/ssh2) 库后端。
**不**调用系统 `ssh`/`scp`/`sftp` 子进程，**不**用 plink，**不**用 ControlMaster，
除本 server 进程外**不启动任何常驻后台进程**（server 退出即无残留）。

---

## 1. 安装

```bash
cd C:/Files/Codes/ssh_mcp
bun install
```

依赖 `ssh2` 的 `cpu-features` 原生模块在装包时会编译（实测 2026-10-26 约 30s），加载成功后走原生 crypto。

### 1.1 单文件产物（推荐给其它机器/客户端用）

不要求对方装 bun：把 server 编译成一个可执行文件，客户端的 `command` 直接指向它。

```bash
cd C:/Files/Codes/ssh_mcp
bun run build                                   # bun build --compile → dist/ssh-mcp.exe（约 96 MiB）
cp dist/ssh-mcp.exe ~/tools/                    # 装到用户目录，路径与仓库位置解耦
bun run dist-verify                             # 对 ~/tools/ssh-mcp.exe 跑 11 项端到端验收
```

接入片段（把 `command` 换成 exe 的绝对路径，其余与第 2 节相同）：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "C:/Users/UnaRem/tools/ssh-mcp.exe",
      "env": { "SSH_MCP_CONFIG": "C:/Files/Codes/ssh_mcp/config.local.json" }
    }
  }
}
```

要点：

- `SSH_MCP_CONFIG` 必须给绝对路径。产物里不含 `config.local.json`（含明文密码，永不入库），
  不显式给就退回「进程 cwd 下的 config.local.json」，而客户端的 cwd 不可靠。
- 更新流程：改完 `src/**` → `bun run build` → 覆盖安装位置的 exe → `bun run dist-verify`。
  exe 不入版本管理（`dist/` 已忽略），可判定的来源始终是源码。
- 实测（2026-10-27）：`--compile` 后行为与源码版一致——11 项验收连续三次 11/11，
  建连 589–615ms（源码版 527–589ms，同一量级；`cpu-features` 若加载失败会退回 JS crypto 而明显变慢，未见退化）。
  另记一次观察：产物刚 `cp` 落地后的第一次运行有 5 项以 transport 关闭的形式失败，随后三次全通过，未复现。

## 2. 接入 MCP 客户端

用**绝对路径**启动，别用相对路径（客户端的工作目录不确定）：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "bun",
      "args": ["run", "C:/Files/Codes/ssh_mcp/src/index.ts"],
      "env": {
        "SSH_MCP_CONFIG": "C:/Files/Codes/ssh_mcp/config.local.json"
      }
    }
  }
}
```

本机 PI-Desktop 的 MCP 配置在 `~/.pi/agent/mcp.json`（同样的 `mcpServers` 形状），已按上面的片段登记为 `ssh`。
工具名前缀由服务端自己决定：PI-Desktop 的可见工具名 = `mcp_` + server 身份名（`-`→`_`）+ `_` + 工具原名，
身份名取 `src/index.ts` 里 `new McpServer({ name: "ssh" })`（实测 2026-10-26：改 mcp.json 的键不影响前缀）。
旧的 `name: "ssh-mcp"` 会得到 `mcp_ssh_mcp_ssh_exec`，前缀与工具名交错重复，模型容易漏写或重复 `ssh_` 段而调用失败；
现在是 `mcp_ssh_ssh_run` / `mcp_ssh_ssh_file`。**如果以前在 mcp.json 里登记过 `ssh-mcp`，请把那条旧条目删掉**，否则同一个 server 注册两份，工具目录翻倍。
`command` 用 bun 的绝对路径（`C:/Users/UnaRem/.bun/bin/bun.exe`）以免受 GUI 进程 PATH 差异影响。**改完这个文件要完整退出并重启 PI-Desktop 进程才会重新发现工具，只重连 server 无效（原因见 2.1）。**
不设 `SSH_MCP_CONFIG` 时 server 会退回 `<进程 cwd>/config.local.json`，所以显式写绝对路径更稳。
也可以写 `bun start`（`package.json` 的 `start` 脚本就是 `bun run src/index.ts`），但 MCP 客户端里推荐上面的直接形式，少一层进程。

另一类客户端不这样命名：OpenCode 用它配置文件（`~/.config/opencode/opencode.json`）里的 mcp 键作命名空间
（本机登记为 `ssh-tool` → `tools["ssh-tool"].ssh_run`），**不读**服务端的身份名，改键即时热重载、不用重启。
两边的命名来源不同：PI-Desktop 的前缀改 `src/index.ts` 的 `name`，OpenCode 只改它的键。

实测（2026-10-27）：OpenCode 改配置会重启该 MCP server（`opencode mcp list` 显示 connected），
但**当前进程的工具目录不会重建**——同一进程里新开的会话/子会话仍看到旧工具名。
服务端换了工具面（如 14 个工具改成 2 个）之后，要完整退出并重启 OpenCode，agent 侧才会出现新名字。
在那之前只能用协议层验收（`bun run live` 走的就是真实 stdio 握手与 `tools/call`）。

启动后 `tools/list` 只返回两个工具：`ssh_run`、`ssh_file`。
这是刻意的窄面（判据见 `docs/domain.md`）；`ssh_run` 不传任何参数就是自省模式，
返回可用主机清单、配置来源、活动连接与会话——原本用来「先看有哪些主机」的那次调用被省掉了。

### 2.1 让客户端能检索到工具（重要）

很多客户端（含 PI-Desktop 的 `pi-mcp-adapter`）靠词法匹配 `name`/`server`/`description` 来决定
是否把工具加载进上下文。**它的分词只保留 ASCII**：中文描述实测完全不参与匹配，纯中文 description
会让模型「找不到工具」。两处都已处理：

1. **服务端（可移植，已实现）**：每个工具 description 末尾追加 ASCII `Keywords: ...`，
   server 还带 `instructions` 说明何时用哪个工具。改的是文本，工具名与 schema 不动。
2. **客户端（PI-Desktop 专有）**：`mcp.json` 的该 server 下可加 `searchKeywords`，按工具名给关键词，
   `"*"` 为全 server 通用。它只影响排序，不展示给模型。示例：

```json
  "ssh": {
    "command": "C:/Users/UnaRem/.bun/bin/bun.exe",
    "args": ["run", "C:/Files/Codes/ssh_mcp/src/index.ts"],
    "env": { "SSH_MCP_CONFIG": "C:/Files/Codes/ssh_mcp/config.local.json" },
    "searchKeywords": {
      "*": ["ssh", "remote", "server", "linux"],
      "ssh_run": ["run command on remote server", "exec", "df disk usage", "uname", "grep log", "persistent shell"],
      "ssh_file": ["upload file", "download file", "send file to remote host", "fetch remote file"]
    }
  }
```

实测（用 adapter 自带的 `scoreToolMatch` 评分，已提交工具元数据）：仅 description 关键词就能让
`"check disk usage on the server"` 命中 `ssh_run`；叠加 `searchKeywords` 分数更高、排序更稳。
工具面从 14 个收成 2 个之后，`searchKeywords` 也要同步改成 `ssh_run` / `ssh_file` 两条——
按旧工具名写的键不会命中任何工具。

**改动 `mcp.json`（含 `searchKeywords`）或工具 description 后，当前会话的工具目录不会自动刷新：**
adapter 日志会写 `direct tools frozen after initial sync — reconnects won't rebuild the system prompt`。
需要**完整退出并重启 PI-Desktop**（不是只重连 server），或在适配器里用 `mcp({ connect: "server" })` 重新发现。

客户端配置（`mcp.json` 及其 `searchKeywords`）由使用侧自己维护，本仓库不代改；
本项目只保证服务端这一侧：description 带 ASCII `Keywords:`、`instructions` 说明何时用哪个工具。
另外，adapter 的 `toolPrefix`（`none`/`short`/`mcp`/`server`）只作用于 adapter 的 proxy 路径，
PI-Desktop 的直接注册路径不受它影响（推断，未实测）——要缩短名字只能改服务端 `name` 或工具名。

## 3. 主机与认证

### 3.1 主机解析顺序

`host` 参数按以下顺序解析，任一命中即可；都不是就报错并**列出全部可用别名**（不会让模型猜 IP）：

1. `config.local.json` 里的 profile（见 3.2）；
2. `~/.ssh/config` 的别名（读 `HostName`/`User`/`Port`/`IdentityFile`，`ProxyJump` 等跳转不跟随）；
3. 直接写 `192.168.1.21` / `user@192.168.1.21` / `host:2222` / `user@[v6]:2222`。

`ssh_run` 不传任何参数就能拿到两处的别名与来源（`source` 字段），以及当前活动连接与会话。

### 3.2 本地 profile（含密码的文件不入库）

复制 `config.example.json` 为 `config.local.json`（已在 `.gitignore` 中）：

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

### 3.3 认证顺序：密钥优先，密码兜底

- 有可用私钥（`identity_files`，或 `~/.ssh/config` 指定的、或 `~/.ssh/` 下的 id_* 文件）时**先试 publickey**，
  失败再试密码——这是显式指定的 `authHandler: ["publickey", "password"]`（`ssh2` 默认顺序是密码在前）。
- 密码来源优先级：`config.local.json` 的 `password` → `SSH_MCP_PASSWORD_<ALIAS大写、非字母数字换成_>` → `SSH_MCP_PASSWORD`。
- 不会弹密码提示：拿不到凭据就在 `SSH_MCP_READY_TIMEOUT_MS` 内失败，并给出可读原因
  （实测对密钥被拒且无密码的主机 1.3s 返回「认证失败：… 拒绝了提供的凭据」）。
- 返回里的 `auth_methods_attempted` / `auth_succeeded_with` 是从 SSH 协议报文实测出来的，不是猜的。

### 3.4 host key

`ssh2` 本身不校验 host key，这里自己实现（`known_hosts` 只**追加**，不改写既有行）：

- `tofu`（默认）：首次连接记录，之后不匹配就拒绝；
- `strict`：没有记录就拒绝；
- `off`：不校验。
- 支持裸 host（对所有端口生效）、`[host]:port`（仅该端口）、IPv6 方括号形式、通配与 `!` 排除、`|` 哈希条目。

`SSH_MCP_KNOWN_HOSTS` 可指定别的 known_hosts 文件（默认 `~/.ssh/known_hosts`）。

## 4. 工具与返回语义

对外只有两个工具，参数只放 shell 给不了的东西（判据与不变量见 `docs/domain.md`）。

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `ssh_run` | `host` `command`；可选 `session`（写 `keep` 或之前返回的 id）`session_op`（`reset`/`close`）`cwd` `env` `timeout_ms` `max_output_bytes` | `ok` `exit_code` `stdout` `stderr` `cwd` `timed_out` `truncated` + 真实总量（`stdout_bytes`/`stdout_lines` 等）+ 连接元信息（`connection`、`auth_*`、`host_key`） |
| `ssh_run`（不传参数） | — | 自省：`hosts` 清单与来源、配置路径、`active_connections`、`active_sessions` |
| `ssh_file` | `host` `entries[]`（`op`=`put`/`get`、`remote_path`、`local_path`、`overwrite`） | 按请求顺序返回每个条目：`bytes_match`、两端字节数、`sha256_local`；单条失败带 `error_code` |

用法要点：

- **多步、取尾部、区间、过滤、写文件、建目录都写在命令里**：`mkdir -p a && cd a && pwd`、
  `journalctl -u app | tail -n 50`、`sed -n '120,180p' f`、`cat > f <<'EOF' … EOF`。没有 `commands[]`、
  `output_mode`、`tail_lines`、`keep_stdin` 这类参数。
- **用户名/端口/host key 策略不是参数**：写在 `~/.ssh/config`（`User`/`HostName`/`Port`/`StrictHostKeyChecking`）
  或用 `user@ip`；否则就是 `config.local.json`（见 3.2）。
- **跨调用保持状态**才用 `session="keep"`：第一次调用建立并返回 `session_id`，之后可以写 id；
  只有一个活动会话时连 `host` 都能省。`session_op="reset"` 回到登录目录、`session_op="close"` 结束会话。
- 一次性调用里 `cwd`/`env` 不会带到下一次——结果会带 `hint` 说明怎么改成会话，不需要额外参数。

返回语义与错误码：

- 成功调用：`ok: true` + JSON（同时给 `structuredContent`）。**命令退出码非 0 不是工具错误**：
  `isError=false`，但顶层 `ok=false`，请看 `exit_code` 与 `stderr`。
- 工具错误：`isError=true` + `error_code` + 可操作的 `error`，并附上补救所需的事实。

| error_code | 何时 | 附带事实 |
| --- | --- | --- |
| `bad_input` | 缺 `command`、`session_op` 与 `command` 同时给、`op` 不是 put/get、多余参数 | `allowed_ops`、`active_sessions`；schema 的 `additionalProperties:false` |
| `unknown_host` | 别名解析不出来 | `available_hosts`、`ssh_config_path`、`local_config_path` |
| `connect_failed` / `auth_failed` / `host_key_mismatch` | 握手/凭据/host key | `hint`、`attempted_methods`、`host_key_fingerprint` |
| `no_session` | 会话不存在或已被 TTL 回收 | `active_sessions`、空闲时长与 TTL |
| `not_found` / `permission` / `exists` | 传输条目的文件系统情形（**按数据返回，调用本身不是错误**） | 条目 `index`、路径 |
| `internal` | 其它未归类 | `error`、`cause` |

其他保证：

- `timeout_ms` 到期 → `timed_out: true`，server 不死，连接仍可用；
- 输出超预算 → `truncated: true`，并回报 `stdout_bytes`/`stdout_lines` 等真实总量；想少看点就在命令里用 `head`/`tail`/`sed`；
- 默认给命令补 `< /dev/null`（`cat` 之类不会挂死）；管道命令不补，以免改变语义；
- 引号未闭合等语法问题会先走远端 `bash -n` 预检，返回「命令未执行」+ bash 的报错（实测 ~20ms），命令不会半执行；
- 后台/常驻进程占住 fd → 哨兵超时后返回 `background_suspect: true` 并自动重开会话；
- 会话空闲超过 TTL → 自动关闭，下次用该 id 会明确说明原因与时长，并提示传 `session="keep"` 重新开始。

## 5. 环境变量（都有默认值）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `SSH_MCP_CONFIG` | `<cwd>/config.local.json` | 本地 profile 文件 |
| `SSH_MCP_SSH_CONFIG` | `~/.ssh/config` | 覆盖 ssh_config 路径（测试用） |
| `SSH_MCP_KNOWN_HOSTS` | `~/.ssh/known_hosts` | known_hosts 路径 |
| `SSH_MCP_PASSWORD` / `SSH_MCP_PASSWORD_<ALIAS>` | — | 密码兜底 |
| `SSH_MCP_READY_TIMEOUT_MS` | 12000 | 握手/认证等待上限 |
| `SSH_MCP_EXEC_TIMEOUT_MS` | 30000 | 命令默认超时（工具可覆盖，上限 600000） |
| `SSH_MCP_SESSION_TTL_MS` | 600000 | 会话空闲 TTL |
| `SSH_MCP_CONN_TTL_MS` | 300000 | 进程内连接池空闲 TTL（新连接实测 ~1.8s，故默认保留） |

## 6. 自检

```bash
bun run lint                 # = bunx tsc --noEmit，类型检查
bun test                     # 离线测试，不需要网络（fake ssh/sftp 替身 + 进程内真 SSH 服务器）
                             # test/contract.test.ts 锁的是对外契约：两个工具、参数集合、错误码、自省模式
bun run live                 # 对真实主机跑 25 项端到端验收，读 config.local.json
LIVE_HOST=lan bun run live
bun run build                # 单文件产物 dist/ssh-mcp.exe（见 1.1）
bun run dist-verify          # 对产物跑 11 项验收，默认验 ~/tools/ssh-mcp.exe；可传路径验 dist/
bun run dist-verify dist/ssh-mcp.exe
```

`live-verify` 会复制一份 `~/.ssh/known_hosts` 到临时目录来跑 TOFU/不匹配用例，不动真实文件，跑完清理远端临时目录。
改完 `src/**` 的远端行为，收官必须跑一次 `bun run live`；只改文档不必跑。
`bun run build` 之后必须跑 `bun run dist-verify`：`--compile` 把依赖（含 `ssh2` 的原生模块）打进单文件，
构建期不报错不代表运行期没问题。

## 7. 边界

- 只支持 Linux 远端；不做 Windows 远端语义适配。
- 不启用 ControlMaster/ControlPersist，不引入系统 ssh 子进程或 plink 后端。
- 不做后台任务/job 家族（异步任务表、轮询取结果）：与「不留常驻进程」冲突，已取消。
- 不把 SFTP 的 list/stat/read/write/mkdir 做成工具：远端 `ls`/`stat`/`sed`/`cat`/`mkdir -p` 更贴近模型既有能力。
- 不做 npm 发布 / Docker / Web UI / 遥测。对外分发只走 `bun build --compile` 的单文件产物（见 1.1），
  不引入包管理分发链路。
- 不读写 `~/.ssh/config`，不改写私钥；对 `known_hosts` 仅追加。
