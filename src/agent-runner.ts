/**
 * agent-runner.ts — Agent 执行器抽象。
 *
 * 真实部署里，agent 是外部进程（Claude Code / Codex / 自研 agent）：Worker 的
 * POST /api/arena 只负责 fork 工作区并发放 {remote, token}，agent 自己 clone、
 * 干活、push；push 事件再触发评审流水线。ScriptedAgent 是本地联调用的
 * “假 agent”，行为确定、可解释，足够端到端验证。
 *
 * 接入真实 coding agent：在你自己的编排器里实现 AgentRunner.run()，
 * 把 ws.remote / ws.token 传给 agent（git remote + token 鉴权），
 * agent push 成功后 resolve 即可。
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { simpleGit } from "simple-git";

export interface Workspace {
  name: string;
  remote: string;
  token: string;
  instructions: string | null;
}

export interface AgentResult {
  commit: string;
  filesChanged: string[];
}

export interface AgentRunner {
  /**
   * 运行 agent。opts 可携带 taskId / agentIndex，供 runner 做日志、
   * 环境变量注入等；老实现忽略它即可（保持向后兼容）。
   */
  run(ws: Workspace, task: string, opts?: AgentRunOptions): Promise<AgentResult>;
}

/** 传给 AgentRunner.run 的可选上下文。 */
export interface AgentRunOptions {
  /** 擂台任务 id（用于日志文件名等） */
  taskId?: string;
  /** agent 在本任务中的编号（0,1,2…） */
  agentIndex?: number;
}

/**
 * Agent 本体运行失败：超时 / 非零退出 / 结束时远端无新提交。
 * 与编排器自身异常区分开——dev-server  catch 到它会把 agent 标为 "failed"
 *（判负），其它异常标为 "error"（基础设施问题）。
 */
export class AgentFailedError extends Error {
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}：${detail}` : reason);
    this.name = "AgentFailedError";
    this.reason = reason;
  }
}

/** 演示用 persona：让三个 agent 的产出有差异，排行榜才有意义。 */
export type Persona = "thorough" | "plain" | "sloppy";

export const PERSONAS: Persona[] = ["thorough", "plain", "sloppy"];

export class ScriptedAgent implements AgentRunner {
  constructor(private persona: Persona = "plain") {}

  async run(ws: Workspace, task: string): Promise<AgentResult> {
    const work = await mkdtemp(join(tmpdir(), `arena-${ws.name}-`));
    try {
      const git = simpleGit({ baseDir: work, binary: "git", trimmed: true });
      // mock remote 是本地裸仓路径；真实环境这里是 https remote + token
      await git.clone(ws.remote, ".");
      await git.addConfig("user.name", `arena-agent`);
      await git.addConfig("user.email", "agent@example.com");

      const stamp = new Date().toISOString();
      const notes = [
        `# Agent 工作记录`,
        ``,
        `- 工作区: ${ws.name}`,
        `- 任务: ${task}`,
        `- 时间: ${stamp}`,
        this.persona === "sloppy" ? `- TODO: 这里还可以优化，先占位` : `- 结论: 按任务描述完成改动`,
        ``,
      ].join("\n");
      await writeFile(join(work, "ARENA-NOTES.md"), notes, "utf8");

      // 一个小而确定的代码改动：往 README 追加一行
      const readme = join(work, "README.md");
      const { readFile } = await import("node:fs/promises");
      const prev = await readFile(readme, "utf8").catch(() => "# Project\n");
      await writeFile(readme, `${prev}\n> [${ws.name}] ${task.slice(0, 60)} (${stamp})\n`, "utf8");

      const filesChanged = ["ARENA-NOTES.md", "README.md"];

      if (this.persona === "thorough") {
        // “靠谱” agent：顺手补测试
        await mkdir(join(work, "test"), { recursive: true });
        await writeFile(
          join(work, "test", "arena.test.ts"),
          `// ${ws.name} 补充的冒烟测试\ntest("arena smoke", () => { expect(1 + 1).toBe(2); });\n`,
          "utf8",
        );
        filesChanged.push("test/arena.test.ts");
      }

      await git.add(filesChanged);
      await git.commit(`arena(${this.persona}): ${task.slice(0, 50)}`);
      await git.push("origin", "main");
      const commit = await git.revparse(["HEAD"]);
      return { commit, filesChanged };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
