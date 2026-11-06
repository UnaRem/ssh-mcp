# ssh-mcp

给 agent 用的 Linux 远端命令执行与文件传输工具：一个跑在 stdio 上的 MCP server。

它把「SSH 远程执行」收敛成一层薄桥：命令按原生 shell 写，桥只补 shell 给不了的东西——
认证与 host key 校验、连接复用、退出码与输出流的分离、输出预算与真实总量、跨调用的会话状态。
对外恰好两个工具：`exec`（执行）与 `transfer`（搬文件）。如果你希望 agent 在远端做事时
写的是 `systemctl status nginx && journalctl -n 50` 这样的原生命令、并且能对结果
（退出码/超时/截断）做判定而不是猜，这个桥就是为它做的。

设计判据与不变量见 [`docs/domain.md`](docs/domain.md)；对外契约由 `test/contract.test.ts` 锁定。
完整用法教学（正反例、会话、超时、传输案例）在随仓库发布的 [`skills/ssh-mcp/SKILL.md`](skills/ssh-mcp/SKILL.md)，
支持技能的客户端会自动注入它。

- 技术栈：Bun + TypeScript + 官方 [MCP SDK](https://modelcontextprotocol.io) + [`ssh2`](https://github.com/mscdex/ssh2)。
- 不调用系统 `ssh`/`scp`/`sftp`/`plink` 子进程，不用 ControlMaster，除本 server 进程外不启动任何常驻后台进程。
- 只支持 Linux 远端（Windows/macOS 本机侧）。

## 目录

- [安装](#安装)
- [配置](#配置)
- [接入 MCP 客户端](#接入-mcp-客户端)
- [用法](#用法)
- [返回语义与错误码](#返回语义与错误码)
- [环境变量](#环境变量)
- [开发](#开发)
- [发布](#发布)
- [边界（明确不做）](#边界明确不做)
- [License](#license)

## 安装

新机器推荐**按 GitHub 仓库安装**（不 clone）：放 exe 一条命令、装 SKILL 一条命令；更新是重跑同两条命令，不用换 URL。

**1. 产物（Windows x64）**——固定名资产 `ssh-mcp-windows-x64.zip` 每个 Release 都挂，`latest` 永远指向最新版：

```powershell
New-Item -ItemType Directory -Force $HOME/tools | Out-Null
if (Get-Process ssh-mcp -ErrorAction SilentlyContinue) { Stop-Process -Name ssh-mcp -Force }  # Windows 不让覆盖正在运行的 exe，先解锁
Invoke-WebRequest https://github.com/UnaRem/ssh-mcp/releases/latest/download/ssh-mcp-windows-x64.zip -OutFile $HOME/tools/ssh-mcp.zip
Expand-Archive $HOME/tools/ssh-mcp.zip $HOME/tools -Force
Remove-Item $HOME/tools/ssh-mcp.zip
```

产物是单文件 exe（含 bun 运行时与原生模块），解压即用，无需其它依赖。第一次启动会在 exe 同级自动生成
配置模板（见「配置」）；编辑 `~/tools/config.local.json`、把客户端 `command` 指向 exe（见「接入 MCP 客户端」）
即完成初始化。更新 = 重跑上面的命令，然后让客户端重连那条 MCP 连接。

**2. SKILL**——支持技能的客户端需要；从本仓库装进 `~/.agents/skills`（pi/opencode/codex 共用的枢纽，
装完自动链到各客户端的技能目录）：

```powershell
npx -y skills add UnaRem/ssh-mcp -g -y
# 更新：npx skills update ssh-mcp -g -y
```

走 [skills CLI](https://skills.sh)，按 lockfile 管理，`update` 会按记录源重新拉取仓库。
SKILL 与工具名由契约测试锁成同版（不变量 12），换 exe 时把它一起跑。

开发期（要改代码）才需要 clone 仓库；bun 版本实测 1.3.14：

| 方式 | 命令 | 适用 |
| --- | --- | --- |
| 源码直跑 | `bun install && bun run src/index.ts` | 开发期（改代码即生效） |
| 本地构建产物 | `bun run build` → `dist/ssh-mcp.exe` | 改动要在产物上验收 |

开发机的 SKILL 直接让客户端读仓库 `skills/`，或用 `bun run sync-skill` 拷到本机技能目录
（默认 `~/.agents/skills/ssh-mcp`，`--target` 可指各客户端自己的目录）。注意别和 skills CLI 的托管混用：
sync-skill 只是拷贝、不进 lockfile，`skills update` 也不认它——装了哪种就用哪种的更新方式。

## 配置

凭据永不入库：含明文密码的只有 `config.local.json`（已被 gitignore）。
配置文件查找顺序（首次启动三处都没有时，会在最优可写位置生成模板，只创建不覆盖）：

1. 环境变量 `SSH_MCP_CONFIG`（绝对路径）；
2. **可执行文件同级的 `config.local.json`** —— 推荐，客户端里一条 env 都不用设；
3. 进程 cwd 下的 `config.local.json`（源码直跑场景；客户端的 cwd 不可靠，别依赖）。

`config.local.json` 形状（先 `exec({})` 自省可以看到当前解析到的全部主机别名）：

```json
{
  "defaults": { "host_key_policy": "tofu" },
  "hosts": {
    "lan": { "hostname": "192.168.1.21", "user": "unarem", "password": "…" },
    "app": { "hostname": "10.0.0.5", "user": "deploy", "identity_files": ["~/.ssh/id_ed25519"], "host_key_policy": "strict" }
  }
}
```

字段：`hostname` `port` `user` `password` `key_passphrase` `identity_files` `host_key_policy`（`tofu`/`strict`/`off`）；
`defaults` 会被具体 profile 覆盖。配置每次调用都重读，改完即时生效。

`host` 参数的解析顺序：profile 别名 → `~/.ssh/config` 别名（读 `HostName`/`User`/`Port`/`IdentityFile`）→
直接写 `192.168.1.21` / `user@ip` / `host:port` / `user@[v6]:port`。解析不出来会报错并列出全部可用别名。

认证：密钥优先、密码兜底（显式 `publickey→password` 顺序）；绝不弹交互提示，缺凭据快速失败且原因可读
（`auth_methods_attempted`/`auth_succeeded_with` 来自协议实测）。
host key 自行校验（ssh2 本身不做）：TOFU 首连记录、`strict` 必须有记录、`off` 不校验；`known_hosts` 只追加不改写。

**凭据约束：密码/私钥不得暴露在公网。** 只纳管局域网/组网内、网络层公网不可达的主机；
公网主机先组网（VPN/内网穿透）再纳管，不放宽这条约束。

## 接入 MCP 客户端

所有客户端配置形状相同，`command` 指向源码（经 bun）或 exe 都可以；用绝对路径——客户端工作目录不确定。

```json
{
  "mcpServers": {
    "ssh": {
      "command": "C:/Users/<you>/.bun/bin/bun.exe",
      "args": ["run", "C:/absolute/path/to/ssh-mcp/src/index.ts"],
      "env": { "SSH_MCP_CONFIG": "C:/absolute/path/to/ssh-mcp/config.local.json" }
    }
  }
}
```

客户端可见的工具名 = 客户端侧命名空间 + 工具原名：

- PI-Desktop 等取服务端身份名（`src/index.ts` 的 `new McpServer({ name: "ssh" })`）→ 可见名 `mcp_ssh_exec` / `mcp_ssh_transfer`；
- OpenCode 取客户端配置里的 mcp 键，不读服务端身份名。

改过工具名或身份名后，要在客户端删掉旧登记并重启/重连（工具目录不自动刷新）：
自检办法是调 `exec({})`，返回里带 `mode:"inventory"` 与 `hint` 才是新工具面。

## 用法

### exec —— 远端执行

不传任何参数 = 自省：返回主机清单与来源、配置路径、活动连接与会话。

```jsonc
// 一条命令完成多步（一次往返）
{ "host": "lan", "command": "cd /srv/app && git pull && systemctl restart app && systemctl is-active app" }
// 长任务：起后台再轮询，不要把 timeout_ms 调大（默认 5000ms 即上限，只能调小）
{ "host": "lan", "command": "nohup ./deploy.sh > /tmp/deploy.log 2>&1 & echo $!" }
{ "host": "lan", "command": "tail -n 50 /tmp/deploy.log; kill -0 12345 && echo RUNNING || echo DONE" }
// 跨调用保持 cwd 与 export：session="keep"，返回 session_id，后续调用带上它
{ "host": "lan", "command": "export DEPLOY=staging && cd /srv/app", "session": "keep" }
```

参数：`host`、`command`、`session`（`keep` 或 `session_id`）、`session_op`（`reset`/`close`）、
`cwd`/`env`（建会话时的起始状态）、`timeout_ms`/`max_output_bytes`（本次调用的上限，只能调小）。

### transfer —— 本机与远端之间搬文件

```jsonc
{ "host": "lan", "entries": [
  { "op": "put", "local_path": "C:/tmp/app.tar", "remote_path": "/tmp/app.tar" },
  { "op": "get", "remote_path": "/var/log/app.log", "local_path": "C:/tmp/app.log", "overwrite": true }
] }
```

多条目共用一条 SFTP 连接、按请求顺序返回；每条回报两端字节数与 `bytes_match`，本机文件另给 `sha256`。
默认不覆盖已存在的目标（`overwrite=true` 才覆盖）。列目录、看属性、读文本、建目录请改用远端
`ls`/`stat`/`sed -n`/`cat`/`mkdir -p`——它们更贴近模型既有能力，所以不做成工具。

更多正反例（含超时、会话、失败条目处理）见 [`skills/ssh-mcp/SKILL.md`](skills/ssh-mcp/SKILL.md)。

## 返回语义与错误码

- 成功调用：`ok: true` + JSON（同时提供 `structuredContent`）。
  **命令退出码非 0 不是工具错误**：`isError=false`、顶层 `ok=false`——按 `exit_code`/`stderr` 判定。
- 工具错误：`isError=true` + 稳定的 `error_code` + 补救所需的事实（未知主机回清单、未知会话回 `active_sessions`）。
- 超时：`timed_out=true` 时已到达的输出原样带回；桥**只是停止等待**，不会终止远端命令——
  要限制时长在命令里写 `timeout <秒> …`，要跑得更久就起后台再轮询。`timeout_ms` 默认即上限（5000ms），
  超出只截不拒并在结果里可见（`timeout_ms_requested`/`timeout_capped`）。
- 截断：`truncated=true` 并回报真实总量（`stdout_bytes`/`stdout_lines`）。

| error_code | 何时 |
| --- | --- |
| `bad_input` | 缺 `command`、`session_op` 与 `command` 同时给、`op` 不是 put/get、越界参数 |
| `unknown_host` | 别名解析不出来（回 `available_hosts`） |
| `connect_failed` / `auth_failed` / `host_key_mismatch` | 握手 / 凭据 / host key（回尝试过的方法与实际指纹） |
| `no_session` | 会话不存在或已被 TTL 回收（回 `active_sessions` 与说明） |
| `not_found` / `permission` / `exists` | 传输条目的文件系统情形——按数据返回在条目里，调用本身不是错误 |
| `internal` | 其它未归类 |

## 环境变量

都有安全默认值；只有 `SSH_MCP_CONFIG` 在配置不在默认位时才需要设。

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `SSH_MCP_CONFIG` | exe 同级 → cwd | 本地 profile 文件路径 |
| `SSH_MCP_SSH_CONFIG` | `~/.ssh/config` | 覆盖 ssh_config 路径（测试用） |
| `SSH_MCP_KNOWN_HOSTS` | `~/.ssh/known_hosts` | known_hosts 路径 |
| `SSH_MCP_PASSWORD` / `SSH_MCP_PASSWORD_<ALIAS>` | — | 密码兜底 |
| `SSH_MCP_READY_TIMEOUT_MS` | 12000 | 握手/认证等待上限 |
| `SSH_MCP_EXEC_TIMEOUT_MS` | 5000 | 命令超时默认值与上限（只能调小） |
| `SSH_MCP_SESSION_TTL_MS` | 600000 | 会话空闲回收 |
| `SSH_MCP_CONN_TTL_MS` | 300000 | 连接池空闲回收 |

## 开发

```bash
bun run lint        # = bunx tsc --noEmit；改完 src/** 必跑
bun test            # 离线单测，不依赖网络（fake 替身 + 进程内真 SSH 服务器）
bun run live        # 对真实主机 27 项端到端验收（读 config.local.json）
bun run sync-skill  # 改 SKILL 后同步到技能目录
bun run build       # 单文件产物 dist/ssh-mcp.exe
bun run dist-verify # 对产物 13 项验收（--offline 只跑协议层 6 项，CI 用）
```

- 分层：`src/tools/*` 只经 `BridgeCtx`（`src/bridge.ts`）访问连接池/会话，不 import 实现模块。
- 对外契约（工具名、参数集合、错误码、自省模式、ASCII `Keywords:`、描述长度上限、SKILL 一致性）
  由 `test/contract.test.ts` 锁死；**改对外面先改它（红），再实现（绿）**。
- `docs/domain.md`（判据）、`test/contract.test.ts`（断言）、`skills/ssh-mcp/SKILL.md`（教学）
  是同一结论的三处，改动对外面时三处同改。
- 改完 `src/**` 的远端行为，收官跑一次 `bun run live`；改完产物必须过 `bun run dist-verify`。
- 提交信息用中文 conventional commits；不 push，push 由维护者掌握。

## 发布

只发 windows-x64 单文件产物，push 驱动：把 `package.json` 的 `version` 改一行并提交——
GitHub Actions（`.github/workflows/release.yml`）在该 commit 创建 `v<版本>` tag，
跑 lint + 离线测试 + 编译 + `dist-verify --offline` 自检，把 zip 挂到 Release；版本号没改的 push 整段跳过。
版本号只写在 `package.json` 一处（代码与契约测试从它读取，tag 由 CI 创建），保证 tag ↔ commit ↔ 二进制对应。
每个 Release 挂两个 zip：`ssh-mcp-<版本>-windows-x64.zip`（按版本存档）与固定名的稳定直链
`ssh-mcp-windows-x64.zip`（「永远取最新版」的安装/更新命令用它，见「安装」）。
不发 npm：安装路径以仓库为准（exe 走 Release 直链、SKILL 走 skills CLI），不占也不依赖 npm 包名——
npm 上的 `ssh-mcp` 名字 2026-11 实测已被另一个项目占用，走 npm 还得改名与发布账号，收益不抵成本。

## 边界（明确不做）

- 不做后台任务/job 家族（异步任务表、轮询取结果）——用 `nohup … &` + 轮询，原生命令能做。
- 不把 SFTP 的 list/stat/read/write/mkdir 做成工具——远端 `ls`/`stat`/`sed`/`cat`/`mkdir -p` 更贴近模型既有能力。
- 不做凭据托管类扩展（公钥自动注册、桥代持/代问 sudo 口令、elicitation）——见「凭据约束」。
- 不启用 ControlMaster，不引入系统 ssh 子进程或 plink 后端；不做 npm 发布 / Docker / Web UI / 遥测。
- 不读写 `~/.ssh/config`，不改写私钥；对 `known_hosts` 仅追加。

理由展开在 [`docs/domain.md`](docs/domain.md)「明确不做」一节。

## License

[MIT](LICENSE)
