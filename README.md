# ssh-mcp —— 给 agent 用的 SSH/SFTP 工具

一个 stdio 上的 MCP server，让 agent 用**尽量少的调用**在 Linux 远端执行命令、传文件、维持连续终端，
并拿到**结构化、可判定**的结果：退出码、stdout/stderr 分离、是否超时、是否截断、当前 cwd。

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
**server 键别写成 `ssh-mcp`**：PI-Desktop 的可见工具名 = `mcp_` + server 键（`-`→`_`）+ `_` + 工具原名，
`ssh-mcp` 会得到 `mcp_ssh_mcp_ssh_exec`（前缀与工具名重复），`ssh` 得到 `mcp_ssh_ssh_exec`，更短且宽泛查询更容易命中。
`command` 用 bun 的绝对路径（`C:/Users/UnaRem/.bun/bin/bun.exe`）以免受 GUI 进程 PATH 差异影响。**改完这个文件要完整退出并重启 PI-Desktop 进程才会重新发现工具，只重连 server 无效（原因见 2.1）。**
不设 `SSH_MCP_CONFIG` 时 server 会退回 `<进程 cwd>/config.local.json`，所以显式写绝对路径更稳。
也可以写 `bun start`（`package.json` 的 `start` 脚本就是 `bun run src/index.ts`），但 MCP 客户端里推荐上面的直接形式，少一层进程。

启动后 `tools/list` 应返回 14 个工具：
`ssh_hosts`、`ssh_exec`、`ssh_batch`、`session_open`、`session_exec`、`session_reset`、`session_close`、
`sftp_list`、`sftp_stat`、`sftp_read`、`sftp_write`、`sftp_mkdir`、`sftp_upload`、`sftp_download`。

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
      "ssh_exec": ["run command on remote server", "exec", "df disk usage", "uname", "grep log"],
      "sftp_upload": ["upload file", "send file to remote host"],
      "sftp_download": ["download file", "fetch remote file"]
    }
  }
```

实测（用 adapter 自带的 `scoreToolMatch` 评分，已提交工具元数据）：仅 description 关键词就能让
`"check disk usage on the server"` 命中 `ssh_exec`；叠加 `searchKeywords` 分数更高、排序更稳。

**改动 `mcp.json`（含 `searchKeywords`）或工具 description 后，当前会话的工具目录不会自动刷新：**
adapter 日志会写 `direct tools frozen after initial sync — reconnects won't rebuild the system prompt`。
需要**完整退出并重启 PI-Desktop**（不是只重连 server），或在适配器里用 `mcp({ connect: "server" })` 重新发现。

## 3. 主机与认证

### 3.1 主机解析顺序

`host` 参数按以下顺序解析，任一命中即可；都不是就报错并**列出全部可用别名**（不会让模型猜 IP）：

1. `config.local.json` 里的 profile（见 3.2）；
2. `~/.ssh/config` 的别名（读 `HostName`/`User`/`Port`/`IdentityFile`，`ProxyJump` 等跳转不跟随）；
3. 直接写 `192.168.1.21` / `user@192.168.1.21` / `host:2222` / `user@[v6]:2222`。

先调 `ssh_hosts` 能拿到两处的别名与来源，以及当前活动会话。

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

所有工具成功时返回 `ok: true` + JSON（同时给 `structuredContent`）；失败时 `isError` + `error_type`/`error`。
**命令退出码非 0 不是工具错误**，而是数据：请看 `exit_code` 与 `stderr`。

| 工具 | 关键参数 | 说明 |
| --- | --- | --- |
| `ssh_hosts` | — | 列别名与来源、活动会话 |
| `ssh_exec` | `host` `command` [`user` `port` `host_key_policy` `timeout_ms` `max_output_bytes` `keep_stdin`] | 单条命令，一次性 shell |
| `ssh_batch` | `host` `commands[]` [`stop_on_error` `max_steps`] | 同一条连接、同一个 shell 内按序执行；批内 `cd` 有效 |
| `session_open` | `host` [`session_id` `cwd` `env`] | 开一个持续存在的远端 shell |
| `session_exec` | `session_id` `command` [`timeout_ms` `max_output_bytes` `keep_stdin`] | `cd`/`export` 跨调用保持，每次返回退出码与 cwd |
| `session_reset` | `session_id` | 重开 shell，cwd 回到登录初始目录 |
| `session_close` | [`session_id`] | 关一个或全部会话 |
| `sftp_list` | `host` `path` [`include_hidden`] | `~` 展开为远端用户家目录（用 `realpath .` 求得） |
| `sftp_stat` | `host` `path` | type/size/mode/mtime/uid/gid |
| `sftp_read` | `host` `path` [`max_bytes`] | 文本读；超限时 `truncated=true` 且 `total_bytes` 是真实大小 |
| `sftp_write` | `host` `path` `content` [`append` `mode`] | 上限 512 KiB，更大文件用 `sftp_upload` |
| `sftp_mkdir` | `host` `path` [`recursive`] | 已存在的目录列入 `already_existing`，不报错 |
| `sftp_upload` | `host` `local_path` `remote_path` [`overwrite`] | 返回 `local_bytes`/`remote_bytes`/`bytes_match` |
| `sftp_download` | `host` `remote_path` `local_path` [`overwrite`] | 本地父目录自动创建 |

其他保证：

- `timeout_ms` 到期 → `timed_out: true`，server 不死，连接仍可用；
- 输出超预算 → `truncated: true`，并回报 `stdout_bytes`/`stdout_lines` 等真实总量；
- 默认给命令补 `< /dev/null`（`cat` 之类不会挂死）；管道命令不补，以免改变语义；需要交互输入用 `keep_stdin: true`；
- 引号未闭合等语法问题会先走远端 `bash -n` 预检，返回「命令未执行」+ bash 的报错（实测 ~20ms），命令不会半执行；
- 后台/常驻进程占住 fd → 哨兵超时后返回 `background_suspect: true` 并自动重开会话；
- 会话空闲超过 TTL → 自动关闭，下次用该 `session_id` 会明确说明原因与时长。

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
bun test                     # 离线单元测试，不需要网络（fake ssh/sftp 替身 + 进程内真 SSH 服务器）
bunx tsc --noEmit            # 类型检查（等价 npm run lint）
bun run scripts/live-verify.ts   # 对真实主机跑 21 项端到端验收，读 config.local.json
LIVE_HOST=lan bun run scripts/live-verify.ts
```

`live-verify` 会复制一份 `~/.ssh/known_hosts` 到临时目录来跑 TOFU/不匹配用例，不动真实文件，跑完清理远端临时目录。

## 7. 边界

- 只支持 Linux 远端；不做 Windows 远端语义适配。
- 不启用 ControlMaster/ControlPersist，不引入系统 ssh 子进程或 plink 后端。
- 不做 npm 发布 / Docker / Web UI / 遥测。
- 不读写 `~/.ssh/config`，不改写私钥；对 `known_hosts` 仅追加。
