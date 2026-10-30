// 共享类型定义。所有对外返回的结果都必须是可判定的结构化对象。

/** 主机密钥校验策略 */
export type HostKeyPolicy = "tofu" | "strict" | "off";

/** 一次工具调用最终解析出来的连接目标 */
export interface ResolvedTarget {
  /** 用户/模型传入的名字（别名或地址） */
  alias: string;
  hostname: string;
  port: number;
  user: string;
  /** 解析来源，便于排错：ssh_config / profile / direct */
  sources: string[];
  /** 本地私钥候选，按顺序尝试（密钥优先） */
  identityFiles: string[];
  /** 已读入的私钥内容，键为文件路径 */
  privateKeys: PrivateKeyEntry[];
  /** 密码兜底，仅来自本地配置或环境变量；永不写入任何入库文件 */
  password?: string;
  keyPassphrase?: string;
  hostKeyPolicy: HostKeyPolicy;
}

export interface PrivateKeyEntry {
  path: string;
  data: Buffer;
  /** 解析出的密钥类型，用于日志与排错 */
  keyType?: string;
}

/** 输出预算（token 保护）：超出即截断，但总字节/总行数必须回报 */
export interface OutputBudget {
  /** stdout + stderr 合计上限 */
  maxBytes: number;
}

/** 执行结果的统一契约：exec / batch / session 共用，避免模型在两种语义间猜 */
export interface ExecResult {
  /** exit_code === 0 且未超时 */
  ok: boolean;
  /** null 表示拿不到退出码（超时或连接中断） */
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  truncated: boolean;
  /** 截断前 stdout 的真实总量 */
  stdout_bytes: number;
  stdout_lines: number;
  stderr_bytes: number;
  stderr_lines: number;
  /** 仅会话执行返回：命令结束后的工作目录 */
  cwd?: string;
  /** 哨兵未出现，疑似后台进程占住 fd */
  background_suspect?: boolean;
  /** 会话疑似被后台进程污染后已自动重开 */
  session_restarted?: boolean;
  /** 传输层/解析层错误（注意：命令本身失败不算 error） */
  error?: string;
  /** 会话 id，供后续调用引用 */
  session_id?: string;
  /** 语法预检未通过时给出的说明 */
  syntax_check?: "passed" | "failed" | "skipped";
  /** 命令若被信号终止，这里给出信号名（如 TERM） */
  signal?: string;
}

/** 连接层面的失败信息，用于把库的报错翻译成可读原因 */
export interface ConnectFailureInfo {
  reason: string;
  hint?: string;
  attempted_methods: string[];
  host_key_fingerprint?: string;
}

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "link" | "other";
  size: number;
  mode: string;
  mtime: number;
}

export interface StatInfo {
  path: string;
  type: "file" | "dir" | "link" | "other";
  size: number;
  mode: string;
  mtime: number;
  uid: number;
  gid: number;
}

/** 批量执行里的单步结果：每步都必须能独立判定 */
export interface BatchStep {
  index: number;
  command: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  truncated: boolean;
  stdout_bytes: number;
  stdout_lines: number;
  /** 该步结束后的工作目录（哨帧带回） */
  cwd?: string;
  error?: string;
}

/** 一次调用、一条连接、一个 shell 内完成多步 */
export interface BatchResult {
  ok: boolean;
  steps: BatchStep[];
  /** 全部步骤执行完的工作目录 */
  cwd: string;
  shell: string;
  duration_ms: number;
  /** 始终是 true：整个批次复用同一条连接与同一个 shell */
  connection_reused: true;
  truncated: boolean;
  /** 提前停止的原因（stop_on_error / 单步超时 / 步数上限） */
  stopped_at?: string;
  /** 提前停止时怎么办：把「剩下的没执行、已产生的输出在哪、怎么控制时长」说清楚 */
  hint?: string;
  /** 因步数上限被丢弃的步数 */
  dropped?: number;
}
