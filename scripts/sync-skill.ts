/**
 * sync-skill —— 把 skills/ssh-mcp 同步到 agent 的技能目录。
 *
 * 为什么它是发布物的一部分：工具 description 只留判定所需的事实（薄面），
 * 案例、反例、完整语义都在 SKILL——SKILL 不随安装到位，agent 就「有工具却不会用」，
 * 薄面策略直接失效。名字一致性由 test/contract.test.ts 锁死，这个脚本只负责搬运。
 *
 * 用法：
 *   bun run scripts/sync-skill.ts                       # 默认目标 ~/.agents/skills/ssh-mcp
 *   bun run scripts/sync-skill.ts --target ~/.pi/agent/skills --target ~/.config/opencode/skills
 *   bun run scripts/sync-skill.ts --dry-run             # 只报告会不会变
 * 每个 --target 是「技能目录」，脚本在其下替换/创建 ssh-mcp 子目录；~ 展开为家目录。
 * 内容一致时跳过不写（幂等，可安全重复执行）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.join(import.meta.dir, "..", "skills", "ssh-mcp");

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name)));
    else out.push(e.name);
  }
  return out;
}

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const targets: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--target") {
    const v = args[++i];
    if (!v) {
      console.error("--target 需要一个目录参数");
      process.exit(1);
    }
    targets.push(expandHome(v));
  }
}
if (targets.length === 0) targets.push(path.join(os.homedir(), ".agents", "skills"));

// 只搬运这个 SKILL：源缺文件或 frontmatter 的 name 与目录不符都视为发布物坏了
const srcSkill = path.join(SRC, "SKILL.md");
if (!fs.existsSync(srcSkill)) {
  console.error(`找不到 ${srcSkill}`);
  process.exit(1);
}
if (!fs.readFileSync(srcSkill, "utf8").includes("name: ssh-mcp")) {
  console.error("SKILL.md 的 frontmatter 缺少 name: ssh-mcp（与目录名 ssh-mcp 必须一致）");
  process.exit(1);
}

let changed = 0;
for (const dir of targets) {
  const dest = path.join(dir, "ssh-mcp");
  const files = walk(SRC);
  let differs = !fs.existsSync(dest);
  if (!differs) {
    differs = files.some((f) => {
      const a = path.join(SRC, f);
      const b = path.join(dest, f);
      return !fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b));
    });
    if (!differs && fs.readdirSync(dest).length !== files.length) differs = true;
  }
  if (!differs) {
    console.log(`已是最新：${dest}`);
    continue;
  }
  if (dry) {
    console.log(`需要同步：${dest}`);
    changed++;
    continue;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.copyFileSync(path.join(SRC, f), path.join(dest, f));
  }
  console.log(`已同步 ${files.length} 个文件 → ${dest}`);
  changed++;
}
console.log(changed === 0 ? "没有变化" : `完成（${dry ? "dry-run：" : ""}${changed} 处${dry ? "需要" : ""}更新）`);
