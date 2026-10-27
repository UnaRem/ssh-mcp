# ssh-mcp 项目 AGENTS.md

Bun + TypeScript 写的 MCP stdio server：远端 Linux 的命令执行、SFTP 传输、连续终端会话。
后端固定为 `ssh2` 库；不引入系统 `ssh`/`plink` 子进程，不引入 ControlMaster、npm 发布、Docker、Web UI。

## 目录地图

```
src/
  index.ts       MCP server 入口：工具注册、进程内连接池、错误映射（guard）
  config.ts      主机解析：config.local.json profile → ~/.ssh/config 别名 → IP 直连；凭据与环境变量
  backend.ts     ssh2 连接：密钥优先 authHandler、hostVerifier、认证过程观测、错误文案翻译
  knownhosts.ts  known_hosts 解析/匹配/仅追加写入（裸 host、[host]:port、IPv6、通配、哈希）
  session.ts     连续终端核心：哨兵协议、stdin 保护、bash -n 预检、ShellSession、SessionManager(TTL)
  exec.ts        ssh_exec / ssh_batch：临时 ShellSession 跑一条或多条命令
  sftlops.ts     sftp_* 全部操作；`~` 经 realpath 展开为远端家目录；大小上限
  result.ts      输出预算与截断（head 60% + tail 40% + 总量回报）、ExecResult 字段
  tool.ts        工具结果形状（content JSON + structuredContent）、默认超时/上限常量
  types.ts       共用类型
test/            离线测试（bun test）：helpers.ts 是 fake ssh/sftp 替身
scripts/live-verify.ts  真实主机端到端验收（21 项），读 config.local.json
.pi/goal/        目标契约；.pi/work/ 是临时探针，不入版本管理
```

不入版本管理（见 `.gitignore`）：`config.local.json`、`.env*`、`*.log`、`.pi/work/`、`node_modules/`、`bun.lock`、`.known_hosts.append.log`。
含明文密码的只有 `config.local.json`，必须保持被忽略。

## 开发与验证命令

来源：`package.json` 的 `scripts`。

| 命令 | 实际执行 | 用途 |
| --- | --- | --- |
| `bun run lint` | `bunx tsc --noEmit` | 类型检查，改完 `src/**` 必跑 |
| `bun test` | `bun test` | 离线单测，全部不依赖网络（fake 替身 + `ssh2.Server` 进程内真服务器） |
| `bun start` | `bun run src/index.ts` | 起 MCP server（stdio） |
| `bun run live` | `bun run scripts/live-verify.ts` | 对真实主机跑端到端验收 |

- 单跑某个文件：`bun test test/session.test.ts`。测试里 `beforeAll/afterAll` 是 Bun 的写法，**没有** `before/after`。
- 改会话/哨兵/预检逻辑：`test/session.test.ts`、`test/exec.test.ts`；改连接与 host key：`test/backend.test.ts`、`test/knownhosts.test.ts`；
  改 SFTP：`test/sftlops.test.ts`；改配置解析：`test/config.test.ts`（它用 `SSH_MCP_SSH_CONFIG`/`SSH_MCP_CONFIG`/临时 `HOME` 隔离真实 `~/.ssh`）；
  改工具面与握手：`test/mcp.test.ts`（它会真起一个 `bun run src/index.ts` 子进程走 stdio）。
- 只改文档不必跑 live；改了 `src/**` 的远端行为，收官要跑一次 `bun run live`。
- 写验收断言前先读实现返回的真实字段名（例如 `sftpPut` 返回 `bytes_match`，没有 `overwritten`），别凭空造字段。

## 交付入口

没有打包/部署脚本：交付物就是本仓库，客户端用绝对路径 `bun run <abs>/src/index.ts` 启动（见 README 的配置片段）。
`scripts/live-verify.ts` 是验收入口：临时目录里复制一份 `~/.ssh/known_hosts` 做 TOFU/不匹配用例，不动真实文件，结束时清理远端临时目录。

## 版本与硬约束（实测 2026-10-26）

- 运行时：bun 1.3.14（node v24.15 也能跑 `bun:test` 语法之外的东西，但测试只用 bun）。目标远端只支持 **Linux**。
- 依赖固定：`@modelcontextprotocol/sdk@1.32.x`、`ssh2@1.17.0`、`ssh-config@5.3.0`、`zod@4.x`。
  `ssh2` 的 `cpu-features` 需要编译（装包约 30s），加载失败会退回 JS crypto——不影响正确性但会变慢。
- 验收主机：`unarem@192.168.1.21`（OpenSSH 9.6p1 Ubuntu，Linux 6.8.0-147-generic），密码认证；有 `sha256sum` 与 sftp 子系统。
  `~/.ssh/config` 里的 `los` 密钥被服务器拒绝，是「认证失败要快速可读」的反例，不作正向用例。
- 连接成本：新建 SSH 连接实测 ~1.8s（到 los，TCP+KEX+认证失败）。因此「快」靠 `ssh_batch`、进程内连接池（`SSH_MCP_CONN_TTL_MS`）
  和连续会话，而不是系统层复用；任何改动若让「一次调用多次建连」，就是回归。
- 密码兜底：本机无 `sshpass`，绝不弹交互提示；凭据缺失必须在 `readyTimeout` 内失败。

## 踩过的坑（改这些代码前先看）

- `ssh2` 默认认证顺序是密码优先，必须显式 `authHandler: ["publickey","password"]`。
- `ssh2` 不做 known_hosts 校验，也不暴露可靠的 `state`/`connected` 字段；存活判断靠 `close`/`error` 事件摘除池条目。
- exec channel 的监听必须在 `conn.exec()` 回调里同步挂；且**必须消费 stdout**，否则可读侧不结束，`close` 永远不会到
  （`syntaxCheck` 曾因此每次都等满 8s）。
- 哨兵行的 `$?`/`$PWD` 必须用双引号让远端 shell 展开；单引号会让退出码和 cwd 变成字面量。
- `guardStdin()` 不能给管道补 `< /dev/null`（会静默改变语义），只看最后一段命令。
- OpenSSH 的 known_hosts 语义：裸 host 条目对所有端口生效，`[host]:port` 才限定端口。
- OpenSSH SFTP 起始目录是用户家目录，所以 `~` 用 `realpath(".")` 展开；`mkdir` 对已存在目录返回笼统的 `SFTP code 4`，
  要 `stat` 一下才知道是「已存在」。
- 连接池按 `user@host:port` 复用，与本地 profile 无关；要验证「密钥优先」或 TOFU 重新校验，必须新建 server 进程或把
  `SSH_MCP_CONN_TTL_MS` 调小。
- 客户端（PI-Desktop `pi-mcp-adapter`）的工具检索是 ASCII 词法匹配，分词丢弃中文：纯中文 description
 等于没有，模型找不到工具（实测 `ssh` 查询只命中 `ssh_hosts`/`session_open`，不命中 `ssh_exec`）。
 因此每个工具 description 末尾要带 ASCII `Keywords:`，且 server 带 `instructions`。改 description 文本
 不动工具名与 schema（名称决定 `mcp_` 前缀与既有调用）。PI-Desktop 还有 `mcp.json` 的 `searchKeywords`
 机制（按工具名/`*`，仅影响排序）。改了 description 或 `searchKeywords` 后当前会话工具目录不刷新，
 要完整重启 PI-Desktop 才重新发现。
- PI-Desktop 的可见工具名 = `mcp_` + 规范化后的 server 身份名（`-` → `_`）+ `_` + 工具原名。
  **身份名取 `src/index.ts` 里 `new McpServer({ name })`，不是 mcp.json 的 server 键**（实测 2026-10-26：改 mcp.json 的键无效，
  只有这里的 `name` 决定前缀）。先前「server 键进入工具名」是从 `git`/`chrome-devtools` 推的，它们的 `name` 恰好与键相同，是混淆样本。
- 不同客户端的命名来源不同，两侧要分别决定，别拿一边的改动去「统一」另一边（实测 2026-10-27）：
  OpenCode 用 `~/.config/opencode/opencode.json` 的 mcp 键作命名空间（现为 `ssh-tool` → `tools["ssh-tool"].ssh_exec`），
  **不读** serverInfo 的 `name`；PI-Desktop 用 `name` 拼 `mcp_` 前缀，改 mcp.json 的键无效。
  所以 OpenCode 的键叫什么都不会与工具名重复；`name` 只能按 PI-Desktop 的约束取 `ssh`（`ssh-tool` 会得到
  `mcp_ssh_tool_ssh_batch`，`ssh` 段被隔开重复，与出过错的形态同类——推断，未实测）。
  OpenCode 改这个键不需要重启：配置文件热重载，MCP server 随之重启（`opencode mcp list` 可见 `ssh-tool connected`）。
- 前缀与工具名交错重复会让模型写错工具名：`name: "ssh-mcp"` 时真实名 `mcp_ssh_mcp_ssh_batch`，实测 5 次调用全错——
  4 次漏写 `ssh_` 段（`mcp_ssh_mcp_batch`/`mcp_ssh_mcp_exec`，调用回落为文本）、1 次重复段（`mcp_ssh_mcp_mcp_ssh_batch`）。
  2026-10-26 改 `name: "ssh"` → `mcp_ssh_ssh_*`（只剩一个 `ssh` 段，无交错）。改完要在 PI-Desktop 端删掉 mcp.json 里旧的
  `ssh-mcp` 登记，否则同一 server 注册两份、工具目录翻倍。
- adapter 的 `toolPrefix`（`none`/`short`/`mcp`/`server`）只作用于 adapter 的 proxy 路径，PI-Desktop 直接注册路径不受它影响
  （推断，未实测）。要缩短名字只能改 `McpServer` 的 `name` 或工具名，`toolPrefix` 无用。
- 改名 `sftp_put`/`sftp_get` → `sftp_upload`/`sftp_download`（2026-10-26）：实测用 adapter 的 `scoreToolMatch`，
  `"upload file to server"` 185→281、`"download remote file"` 145→241，其余查询分数不变。反例是「全部去掉协议前缀」：
  单词 `ssh` 查询 562→432、`execute a command over ssh` 332→292，且泛化名（`run`/`read`/`list`）会与本地
  `fastctx` 工具互抢。检索按 token 去重计分，所以名字里重复的 `ssh`/`mcp` 不加分也不减分，重叠只是观感问题。

## 环境事实的维护

- 文档没写、但任务需要的环境信息：先自己探测，确认后补进上面的「版本与硬约束」，带实测日期。
- 文档写了、但执行报错：不打断任务，先用正确工具把事做完；收官列出哪条与实际不符、实测结果、建议怎么改，经确认再更新本文件。
