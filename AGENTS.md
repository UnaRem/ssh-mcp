# ssh-mcp 项目 AGENTS.md

Bun + TypeScript 写的 MCP stdio server：远端 Linux 的命令执行与文件传输。
**对外只有一层「SSH 桥」：两个工具 `ssh_run`（跑命令）+ `ssh_file`（搬文件）**；命令按原生 shell 透传，
桥只补 shell 给不了的东西。判据与不变量在 `docs/domain.md`，`test/contract.test.ts` 锁的就是那份结论。
后端固定为 `ssh2` 库；不引入系统 `ssh`/`plink` 子进程，不引入 ControlMaster、后台任务/job、npm 发布、Docker、Web UI。

## 目录地图

```
src/
  tools/run.ts   对外契约 1：ssh_run 的 schema + handler（自省、会话解析、一次性执行）
  tools/file.ts  对外契约 2：ssh_file 的 schema + handler（put/get 批量，单条失败按数据返回）
  schema.ts      参数片段与其文档：只放 shell 给不了的东西；默认值/范围写进 description
  envelope.ts    失败侧唯一出口：ErrorCode 枚举、BridgeError、fromError/classifyMessage
  bridge.ts      门面与内部上下文的边界类型：BridgeCtx / Acquired / ToolDef / runOptions
  index.ts       装配：配置与超时、进程内连接池、会话登记、inventory()、错误映射、注册中间件
  config.ts      主机解析：config.local.json profile → ~/.ssh/config 别名 → IP 直连；凭据与环境变量
  backend.ts     ssh2 连接：密钥优先 authHandler、hostVerifier、认证过程观测、错误文案翻译
  knownhosts.ts  known_hosts 解析/匹配/仅追加写入（裸 host、[host]:port、IPv6、通配、哈希）
  session.ts     连续终端核心：哨兵协议、stdin 保护、bash -n 预检、ShellSession、SessionManager(TTL)
  exec.ts        一次性执行（ssh_run 不带 session 的那条路径）：临时 ShellSession 跑一条命令
  sftlops.ts     SFTP 操作（含 openSftp/put/get）；`~` 经 realpath 展开为远端家目录；大小上限
  result.ts      输出预算与截断（head 60% + tail 40% + 总量回报）、ExecResult 字段
  tool.ts        工具结果形状（content JSON + structuredContent）、默认超时/上限常量
  types.ts       共用类型
docs/domain.md   领域模型：判据（桥只补 shell 给不了的）、统一语言、不变量、错误码语义
test/            离线测试（bun test）：helpers.ts 是 fake ssh/sftp 替身；contract.test.ts 锁对外契约
scripts/live-verify.ts  真实主机端到端验收（25 项），读 config.local.json
.pi/goal/        目标契约；.pi/work/ 是临时探针，不入版本管理
```

工具层（`src/tools/*`）不得 import 连接池/会话登记等实现细节，只经 `BridgeCtx` 取用——
「对外只有一层桥」要靠这条边界检查，而不是靠约定。

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
  **改对外契约（工具名、参数集合、错误码、自省模式）：`test/contract.test.ts`**——它真起一个 `bun run src/index.ts`
  子进程走 stdio，断言属性集合恰好等于声明值（多一个参数即失败），并断言每个参数自带文档与 ASCII `Keywords:`。
- 契约是 TDD 资产：改对外面先改 `test/contract.test.ts`（红），再实现（绿）。`docs/domain.md` 与它是同一结论的两处，
  必须同步改；只改一边会被下一个改动打回。
- 只改文档不必跑 live；改了 `src/**` 的远端行为，收官要跑一次 `bun run live`（25 项，全 PASS 才算完）。
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
- 连接成本：新建 SSH 连接实测 ~1.8s（到 los，TCP+KEX+认证失败）；复用同一条连接的一条命令实测 5–60ms。
  因此「快」靠**进程内连接池（`SSH_MCP_CONN_TTL_MS`）**、连续会话、`&&` 合并多步（一次往返）、
  以及 `ssh_file` 一次传多个条目（共用一条 SFTP 连接），不是系统层复用；
  任何改动若让「一次调用多次建连」，就是回归。
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
- 工具检索普遍按 ASCII 词法匹配（分词丢弃中文）：纯中文 description 等于没有，模型找不到工具
  （实测：`ssh` 查询只命中含 `ssh` 的泛化名，不命中真正要用的工具）。因此每个工具 description 末尾必须带
  ASCII `Keywords:`，server 另带 `instructions`。这属于对外契约，`test/contract.test.ts` 会断言。
- 客户端可见的工具名 = 客户端侧命名空间 + 工具原名，而命名空间的来源各客户端不同：有的取服务端
  `new McpServer({ name })`，有的取客户端配置里的 mcp 键。两条通用结论：
  1) 服务端 `name` 要短，且不能与工具名的段交错重复——`name:"ssh-mcp"` 时真实名是 `mcp_ssh_mcp_ssh_batch`，
     实测 5 次调用全错（4 次漏 `ssh_` 段、1 次重复段），改成 `name:"ssh"` 后只剩一个 `ssh` 段；
  2) 换 `name` 之后要在客户端删掉旧身份的登记，否则同一个 server 注册两份、工具目录翻倍。
- 工具改名会改变检索得分（2026-10-26 实测：`sftp_put`→`sftp_upload` 让 upload 类查询 185→281）。
  反例是去掉协议前缀改用泛化名（`run`/`read`/`list`）：会与同一环境里其它工具互抢。
  检索按 token 去重计分，所以名字里重复的段不加分也不减分，重叠只是观感问题。
- 改了 description 或客户端侧的关键词，当前会话的工具目录通常不刷新：按所用客户端的重发现方式处理
  （有的要完整重启进程，有的改配置即热重载）。各客户端的具体接入配置写在 README 第 2 节——
  那是使用侧的配置，不是本项目的约束，改客户端配置不动本仓库的代码与测试。
- `mcp.registerTool` 从对象上取下来再调用必须 `.bind(mcp)`，否则 `this._registeredTools` 是 undefined，
  server 启动即退出（实测报错 `TypeError: undefined is not an object (evaluating 'this._registeredTools')`）。
- MCP SDK 在调用 handler **之前**就用 inputSchema 解析参数并剥掉未知键，所以自己在 handler 里查「多余参数」永远查不到。
  要参数严格就写 `z.object(shape).strict()`：发布的 JSON Schema 会带 `additionalProperties:false`，模型能自己看见边界。
  代价：这条失败由 SDK 抛出，返回只有文本、**没有 structuredContent**，也没有 `error_code`——契约测试因此断言的是
  「文本里点出写错的键名」，别断言 structuredContent。
- `ssh_run` 的 `host`/`command` 必须是 `.optional()`：自省模式（什么都不传）要在 schema 层通过，
  否则 SDK 直接报 `expected string, received undefined at host`，根本进不到 handler（实测 2026-10-27）。
  「该传什么」由 handler 判定并给可操作说明。
- `tool.ts` 的 `ok()` 要写成 `{ ok: true, ...payload }`：反过来（`{...payload, ok: true}`）会把工具自己给的
  `ok:false` 抹平，「命令 exit_code != 0 是数据但顶层 ok=false」这条契约就失效（实测：`sh -c 'exit 7'` 返回 ok=true）。
- 出错的调用**不要**无条件摘连接池项：`dropHost` 会连带关掉该主机上的会话，实测一次 `op` 写错的 `ssh_file`
  调用让 `keep` 会话凭空消失、后续 `session` 调用报 `no_session`。连接真的断了由 ssh2 的 `close`/`error` 事件摘除，
  空闲过 TTL 的在下次取用时判定丢弃（`acquire` 里必须在取用时判 TTL，只靠 30s 一次的清扫会让短 TTL 形同虚设）。

## 环境事实的维护

- 文档没写、但任务需要的环境信息：先自己探测，确认后补进上面的「版本与硬约束」，带实测日期。
- 文档写了、但执行报错：不打断任务，先用正确工具把事做完；收官列出哪条与实际不符、实测结果、建议怎么改，经确认再更新本文件。
