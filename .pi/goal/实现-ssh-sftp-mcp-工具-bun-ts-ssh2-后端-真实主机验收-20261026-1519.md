# 目标契约：ssh-mcp —— 更快更准的 SSH/SFTP agent 工具

## Goal

在空工作区 `C:/Files/Codes/ssh_mcp` 建成一个 MCP stdio server，让 agent 用**尽量少的一次调用**在 Linux 远端执行命令、传输文件、维持连续终端，并返回**结构化、可判定**的结果（退出码、stdout/stderr、是否超时、是否截断、当前 cwd）。

技术栈按已确认决策：Bun/TypeScript + 官方 MCP SDK + `ssh2` 库后端（不用系统 ssh 子进程、不用 plink）。主机/密钥/known_hosts 复用本地 `~/.ssh`，认证顺序为**本地密钥优先、密码兜底**，不做常驻后台进程、不做 ControlMaster 复用。

## 已实测事实（实现与验收的依据）

- 工作区为空目录、无 git；本机 OpenSSH 10.2p1，**无 sshpass**；bun 1.3.14 / node 24.15；`registry.npmjs.org` 可达。
- 每次新建 SSH 连接代价实测 **~1.8s**（到 `los`）——因此"快"的手段是单次调用批量执行与连接内连续会话，不是靠系统层复用。
- `ssh2@1.17.0` + `ssh-config@5.3.0` 可安装（35.8s，其中 `cpu-features` postinstall 30s）；`cpu-features` 实际加载成功（原生 crypto）。
- `utils.parseKey(Buffer)` 能解析本机 OpenSSH 格式 ED25519 私钥与 `known_hosts` 的 wire format（即现有 `~/.ssh/unarem`、7 条 known_hosts 可复用）。
- 算法可协商：curve25519 KEX、aes*-gcm、hmac-*-etm、`ssh-ed25519`/`rsa-sha2-512` 均在 ssh2 支持列表。
- `ssh2/lib/client.js` 中**无** known_hosts 校验 → host key 匹配需自实现；`ssh-config@5.3.0` 的 `compute({Host:'los'})` 返回 `{}`、`toString()` 抛库内 TypeError → 不能盲用，需按文档核实或自写解析。
- 验收主机（用户提供，局域网）：`unarem@192.168.1.21`，密码认证。实测：22 端口开放、`OpenSSH_9.6p1 Ubuntu-3ubuntu13.20`、`Linux 6.8.0-147-generic`、提供 publickey+password、`sha256sum` 与 `sftp` 存在；密码经 `SSH_ASKPASS_REQUIRE` 登录成功。
- `~/.ssh/config` 内的 `los` 其 ED25519 key 被服务器拒绝 → 该主机作为"认证失败要快速失败并给出可读原因"的测试用例，不作正向用例。

## Acceptance criteria

以下每一项都必须由我在实现后实际执行并给出证据。

1. **可启动**：`bun run src/index.ts`（或 README 写明的等价命令）在 stdio 上完成 MCP 握手，`tools/list` 返回下列全部工具：`ssh_hosts`、`ssh_exec`、`ssh_batch`、`session_open`、`session_exec`、`session_reset`、`session_close`、`sftp_list`、`sftp_stat`、`sftp_read`、`sftp_write`、`sftp_mkdir`、`sftp_put`、`sftp_get`。
2. **主机解析准确**：`ssh_hosts` 从 `~/.ssh/config` 读出别名 `los`；对未知 host 的调用返回错误并列出可用别名，而不是让模型猜 IP。
3. **真实执行**：对 `192.168.1.21` 执行 `uname -sr`，返回 `exit_code=0` 且 stdout 含 `Linux 6.8.0`。
4. **失败可判定**：执行必然失败的命令（如 `sh -c 'echo to stderr >&2; exit 7'`）返回 `exit_code=7`、stderr 被单独取回，**不**被当成工具错误抛出。
5. **认证策略**：先尝试本地密钥、失败后自动走密码兜底完成登录；两条路径都不会在密码提示上挂死（密钥不可用时 ≤ `readyTimeout` 内返回）。
6. **单次调用多步**：`ssh_batch(["cd /tmp","pwd"])` 在**同一条连接**内完成，返回每步各自的 exit_code/stdout（体现连接复用收益；对比基线为 1.8s/连接）。
7. **连续终端语义**：`session_open` → `session_exec('cd /tmp')` → `session_exec('pwd')` 返回 `/tmp`（状态跨调用保持）；每条结果都带哨兵解析出的退出码与 cwd；`session_reset` 后 cwd 回到初始值；空闲超过 TTL 自动关闭并回报原因。
8. **会话鲁棒性**：吞 stdin 的命令（`cat`）、未闭合引号、后台进程挂住 fd 三种情况都不会让工具无限挂起——分别按"补 `</dev/null`"、"`bash -n` 预检报错"、"哨兵超时并回报 `background_suspect` + 重开会话"处理，均有测试覆盖。
9. **host key 校验**：首次连接按 TOFU 记录到 `known_hosts`（只追加、不改写既有行）；host key 不匹配时拒绝连接并明确报告；IPv6 与 `[host]:port` 形式的条目能正确匹配。
10. **超时与输出预算**：`timeout` 到期的命令返回 `timed_out=true` 且 server 进程不死；`limit` 截断时 `truncated=true` 并回报总字节/总行数，避免 token 爆炸。
11. **传输可用**：对真实主机 `sftp_put` + `sftp_get` 往返一致，并用远端 `sha256sum` 与本地哈希比对通过；`sftp_list`/`sftp_stat`/`sftp_read`/`sftp_write`/`sftp_mkdir` 各有一条对真实主机的成功调用记录；超过大小上限时拒绝并说明上限。
12. **离线测试通过**：`bun test` 全绿；单元测试用 fake ssh/sftp 替身，不需要网络；`bun run lint`/`bunx tsc --noEmit`（按 package.json scripts 定义）无错误。
13. **交付文档**：`README.md` 写明 MCP 客户端配置片段（绝对路径 `bun run` 启动）、认证配置方式；项目 `AGENTS.md` 按全局规范含目录地图、开发与验证命令（注明来源文件）、环境硬约束带实测日期；`.gitignore` 覆盖含密码的本地配置文件。
14. **Git 记录**：`git init` 后按 `<type>(<scope>): <中文描述>` 提交；`git status` 干净，且 `git log -p` 中**不含明文密码**（含密码的文件已被忽略）。

## Boundaries

- 只支持 **Linux** 远端；不做 Windows 远端语义适配（PowerShell、CRLF 归一化只处理客户端侧换行，不承诺 Windows 目标机）。
- **不启用** ControlMaster/ControlPersist，**不引入** 系统 ssh 子进程后端、plink/PuTTY 后端、ssh 库以外的传输实现；除 MCP server 自身进程外**不启动任何常驻后台进程或守护进程**（server 退出即无残留）。
- **不做** npm 发布 / bunx 分发 / Docker / Web UI / 遥测；不新增与目标无关的服务或工具链。
- 密码只从本地配置（env 或被 git 忽略的本地文件）读取：**不把密码写入任何入库文件**；不读写 `~/.ssh/config`、不改写私钥；对 `known_hosts` 仅追加。
- 不引入 ANSI 屏幕快照（headless 终端）方案；输出走真实 stdout/stderr channel。
- 不改动工作区外的用户文件；不动 `~/.ssh` 既有内容（除上述 known_hosts 追加）。
