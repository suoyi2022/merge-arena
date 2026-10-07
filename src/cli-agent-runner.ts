/**
 * cli-agent-runner.ts — 通过任意 coding-agent CLI 运行擂台 agent。
 *
 * 用法：在 arena.config.json 里把 agent.kind 切到 "cli"：
 *
 *   { "agent": {
 *       "kind": "cli",
 *       "command": "my-agent-cli",
 *       "args": ["--prompt", "$ARENA_TASK", "--cwd", "$ARENA_WORKSPACE_DIR"],
 *       "timeoutMs": 1200000 } }
 *
 * 或用完整 shell 模板（template 与 command/args 二选一）：
 *
 *   { "agent": {
 *       "kind": "cli",
 *       "command": "my-agent-cli",
 *       "template": "echo $ARENA_TASK | {agent} --stdin --cwd $ARENA_WORKSPACE_DIR" } }
 *
 * 注意：template 里直接写裸 $VAR，不要自己加引号——runner 会自动做 shell
 * 转义；自己加了引号反而会错。
 *
 * 环境变量契约（runner 在启动 CLI 前注入）：
 *   ARENA_GIT_REMOTE     工作区 git remote（真实环境是 Artifacts HTTPS 地址）
 *   ARENA_GIT_TOKEN      该工作区的短期写 token
 *   ARENA_TASK           本次擂台任务描述
 *   ARENA_WORKSPACE_DIR  已 clone 好的工作目录，agent 直接在这里干活
 *   ARENA_AGENT_INDEX    agent 编号（0,1,2…）
 *   ARENA_WORKSPACE_NAME 工作区名
 *
 * 流程：建临时目录 → clone（token 注入 remote）→ 起 CLI（日志落盘）→
 * 超时/非零退出判负 → git ls-remote 校验远端确有新 push → 返回 commit 与变更文件。
 */
import { mkdtemp, rm, mkdir, appendFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { simpleGit } from "simple-git";
import {
  AgentFailedError,
  type AgentResult,
  type AgentRunner,
  type AgentRunOptions,
  type Workspace,
} from "./agent-runner.js";

export interface CliAgentConfig {
  /** CLI 二进制名（必须是单个可执行文件，参数走 args/template）。 */
  command: string;
  /** 参数数组；其中的 $VAR / ${VAR} 会被按字面替换（无 shell 参与）。 */
  args?: string[];
  /**
   * 完整 shell 模板，与 command/args 二选一（template 优先）。
   * {agent} 展开为 command，$VAR / ${VAR} 展开为 shell 引号包裹的值，
   * 经 `sh -c` 执行。示例：`echo $ARENA_TASK | {agent} --stdin`
   *（直接写裸 $VAR，不要自己加引号，runner 会自动转义）。
   */
  template?: string;
  /** 超时毫秒数，默认 20 分钟。 */
  timeoutMs?: number;
  /** 额外注入的环境变量（ARENA_* 之外）。 */
  env?: Record<string, string>;
  /** 日志目录，默认 <项目>/data/logs。 */
  logDir?: string;
  /** 保留临时工作目录（调试用），默认删除。 */
  keepWorkspace?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const TAIL_LINES = 40;

const VAR_RE = /\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function quoteShell(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** $VAR / ${VAR} 按字面替换（args 数组模式，无 shell）。 */
export function expandVars(s: string, vars: Record<string, string>): string {
  return s.replace(VAR_RE, (_m, a: string, b: string) => vars[a ?? b] ?? "");
}

/** $VAR / ${VAR} 按 shell 引号替换（template 模式，经 sh -c）。 */
export function expandShell(s: string, vars: Record<string, string>): string {
  return s.replace(VAR_RE, (_m, a: string, b: string) => quoteShell(vars[a ?? b] ?? ""));
}

/**
 * 把 token 注入 HTTPS remote 做鉴权（`https://<token>@host/...`）。
 * mock 的本地路径 remote 原样返回。token 中的特殊字符经 URL 编码，
 * git 端会解码还原。
 */
export function withToken(remote: string, token: string): string {
  if (!token || token.startsWith("mock_") || !remote.startsWith("https://")) {
    return remote;
  }
  const u = new URL(remote);
  u.username = token;
  return u.toString();
}

function killTree(child: ChildProcess): void {
  try {
    if (child.pid && process.platform !== "win32") {
      process.kill(-child.pid, "SIGKILL"); // 进程组：连带 CLI 拉起的子进程一起杀
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* 已经退出了 */
  }
}

export class CliAgentRunner implements AgentRunner {
  private readonly timeoutMs: number;
  private readonly logDir: string;

  constructor(private readonly config: CliAgentConfig) {
    if (!config.command) throw new Error("CliAgentRunner 需要配置 command（CLI 二进制名）");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logDir = config.logDir ? resolve(config.logDir) : resolve("data/logs");
  }

  async run(ws: Workspace, task: string, opts: AgentRunOptions = {}): Promise<AgentResult> {
    const agentIndex = opts.agentIndex ?? 0;
    const safeId = (opts.taskId ?? ws.name).replace(/[^a-zA-Z0-9_-]/g, "_");
    await mkdir(this.logDir, { recursive: true });
    const logPath = join(this.logDir, `arena-${safeId}-agent-${agentIndex}.log`);

    const work = await mkdtemp(join(tmpdir(), `arena-cli-${ws.name}-`));
    const header = [
      `=== Merge Arena agent run ===`,
      `时间: ${new Date().toISOString()}`,
      `工作区: ${ws.name}  (agent #${agentIndex})`,
      `任务: ${task}`,
      `目录: ${work}`,
      ``,
    ].join("\n");
    await appendFile(logPath, header, "utf8");
    const log = createWriteStream(logPath, { flags: "a" });

    try {
      // 1. clone 工作区（token 注入 remote，agent 直接 push 即可）
      const git = simpleGit({ baseDir: work, binary: "git", trimmed: true });
      const authed = withToken(ws.remote, ws.token);
      await git.clone(authed, ".").catch((e) => {
        throw new Error(`clone 工作区失败: ${String(e)}`);
      });
      await git.addConfig("user.name", `arena-agent-${agentIndex}`);
      await git.addConfig("user.email", "agent@example.com");
      const baselineHead = await git.revparse(["HEAD"]).catch(() => "");

      // 2. 注入环境变量并启动 CLI
      const vars: Record<string, string> = {
        ARENA_GIT_REMOTE: ws.remote,
        ARENA_GIT_TOKEN: ws.token,
        ARENA_TASK: task,
        ARENA_WORKSPACE_DIR: work,
        ARENA_AGENT_INDEX: String(agentIndex),
        ARENA_WORKSPACE_NAME: ws.name,
      };
      const env: NodeJS.ProcessEnv = { ...process.env, ...this.config.env, ...vars };

      let bin: string;
      let argv: string[];
      let useShell = false;
      if (this.config.template) {
        const expanded = expandShell(
          this.config.template.split("{agent}").join(quoteShell(this.config.command)),
          vars,
        );
        bin = "sh";
        argv = ["-c", expanded];
        useShell = true;
      } else {
        bin = this.config.command;
        argv = (this.config.args ?? []).map((a) => expandVars(a, vars));
      }
      await appendFile(logPath, `$ ${useShell ? `${bin} ${argv[1]}` : [bin, ...argv].join(" ")}\n\n`, "utf8");

      const child = spawn(bin, argv, {
        env,
        cwd: work,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const tail: string[] = [];
      const pushLine = (chunk: Buffer | string) => {
        const lines = String(chunk).split("\n");
        for (const l of lines) {
          tail.push(l);
          if (tail.length > TAIL_LINES) tail.shift();
        }
      };
      child.stdout?.on("data", (c) => {
        log.write(c);
        pushLine(c);
      });
      child.stderr?.on("data", (c) => {
        log.write(c);
        pushLine(c);
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, this.timeoutMs);
      // timer 不应拖住进程退出
      (timer as unknown as { unref?: () => void }).unref?.();

      const exitCode: number = await new Promise((resolvePromise, rejectPromise) => {
        child.on("error", (err) => {
          clearTimeout(timer);
          rejectPromise(new Error(`启动 CLI 失败: ${String(err)}`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolvePromise(code ?? 1);
        });
      });
      log.end();

      if (timedOut) {
        throw new AgentFailedError("agent 执行超时", `超过 ${Math.round(this.timeoutMs / 60000)} 分钟仍未结束`);
      }
      if (exitCode !== 0) {
        throw new AgentFailedError(
          "agent 非零退出",
          `exit code ${exitCode}；日志尾部（${logPath}）：\n${tail.filter((l) => l.trim()).join("\n")}`,
        );
      }

      // 3. 校验远端确有新 push（防“跑完了但没提交”）
      const ls = await git.raw(["ls-remote", "origin", "main"]).catch((e) => {
        throw new AgentFailedError("读取远端失败", String(e));
      });
      const remoteHead = ls.split(/[\s\t]/)[0]?.trim() ?? "";
      if (!remoteHead) {
        throw new AgentFailedError("远端 main 不存在或不可读", `git ls-remote 返回为空`);
      }
      if (baselineHead && remoteHead === baselineHead) {
        throw new AgentFailedError("agent 未推送任何新提交", `远端 HEAD 仍是 ${baselineHead.slice(0, 8)}`);
      }

      const diffOut = baselineHead
        ? await git.raw(["diff", "--name-only", baselineHead, remoteHead])
        : await git.raw(["ls-tree", "-r", "--name-only", remoteHead]);
      const filesChanged = diffOut.split("\n").map((s) => s.trim()).filter(Boolean);
      return { commit: remoteHead, filesChanged };
    } finally {
      log.end();
      if (!this.config.keepWorkspace) {
        await rm(work, { recursive: true, force: true });
      }
    }
  }
}
