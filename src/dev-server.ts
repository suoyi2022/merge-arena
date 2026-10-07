/**
 * dev-server.ts — 本地开发服务器（无需 Cloudflare 账号）。
 * 用 MockArtifactsStore（./data/mock-repos 下的 git 裸仓）+ 文件任务存储，
 * 并在后台自动跑 agent（默认 ScriptedAgent；arena.config.json 里
 * agent.kind="cli" 可切换为真实 coding-agent CLI），完整模拟
 * “开赛 → 并发编码 → push → 评审”。
 *
 * npm run dev → http://localhost:8787
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { MockArtifactsStore } from "./artifacts-mock.js";
import { ScriptedAgent, PERSONAS, AgentFailedError, type Persona } from "./agent-runner.js";
import { CliAgentRunner, type CliAgentConfig } from "./cli-agent-runner.js";
import { FileTaskStore } from "./store.js";
import { routeRequest, type RouteContext } from "./routes.js";
import { reviewTask } from "./review.js";

const PORT = 8787;
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DATA_DIR = join(ROOT, "data");
const PUBLIC_DIR = join(ROOT, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const SEED_FILES: Record<string, string> = {
  "README.md": "# NewsNow 演示基线\n\nMerge Arena 演示用基线仓库：三个 agent 在此并发实现同一个需求。\n",
  "AGENTS.md": "# Agent 须知\n\n- 所有改动提交到 main 分支\n- 保持代码简洁，顺手补测试\n- 不要留 TODO\n",
  "src/app.ts": "export function headline(): string {\n  return \"hello arena\";\n}\n",
  "package.json": JSON.stringify({ name: "newsnow-baseline", version: "0.1.0" }, null, 2) + "\n",
};

/**
 * agent 配置（arena.config.json，可选；缺省= scripted 零依赖模式）。
 * kind 切到 "cli" 后，dev-server 用 CliAgentRunner 拉起真实 coding-agent CLI。
 */
interface ArenaFileConfig {
  agent?: { kind?: "scripted" | "cli" } & Partial<CliAgentConfig>;
}

async function loadFileConfig(): Promise<ArenaFileConfig> {
  try {
    const raw = await readFile(join(ROOT, "arena.config.json"), "utf8");
    return JSON.parse(raw) as ArenaFileConfig;
  } catch {
    return {};
  }
}
const taskLocks = new Map<string, Promise<void>>();

/**
 * 任务级互斥锁（仅 dev）：并行 agent 的读-改-写必须串行化，
 * 否则后保存的会覆盖先保存的状态。生产环境请用 D1/KV 事务代替。
 */
async function withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prev = taskLocks.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => {
    release = res;
  });
  const chained = prev.then(() => next);
  taskLocks.set(taskId, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (taskLocks.get(taskId) === chained) taskLocks.delete(taskId);
  }
}

async function main(): Promise<void> {
  const store = new MockArtifactsStore(join(DATA_DIR, "mock-repos"));
  await store.init();
  await store.seedBaseline("newsnow-baseline", SEED_FILES);
  const tasks = new FileTaskStore(join(DATA_DIR, "tasks"));

  // agent 执行器选择：默认 scripted（零依赖）；arena.config.json 里
  // agent.kind = "cli" 则用 CliAgentRunner 拉起真实 coding-agent CLI。
  const fileConfig = await loadFileConfig();
  const agentCfg = fileConfig.agent ?? { kind: "scripted" as const };
  // cli 模式需要 command（template 里的 {agent} 也要靠它展开）；缺失则回退 scripted
  const cliConf: CliAgentConfig | null =
    agentCfg.kind === "cli" && agentCfg.command
      ? {
          command: agentCfg.command,
          args: agentCfg.args,
          template: agentCfg.template,
          timeoutMs: agentCfg.timeoutMs,
          env: agentCfg.env,
          logDir: agentCfg.logDir ?? join(DATA_DIR, "logs"),
          keepWorkspace: agentCfg.keepWorkspace,
        }
      : null;
  if (agentCfg.kind === "cli" && !cliConf) {
    console.warn("[arena] agent.kind=cli 但未配置 command，回退到 scripted");
  } else if (cliConf) {
    console.log(`[arena] 真实 agent 模式: ${cliConf.template ? "template" : cliConf.command}`);
  }

  const ctx: RouteContext = {
    store,
    tasks,
    makeRunner: (persona: Persona) =>
      cliConf ? new CliAgentRunner(cliConf) : new ScriptedAgent(persona),
    onTaskCreated: (taskId) => {
      // 后台跑假 agent（不阻塞响应），模拟真实部署里外部 agent 的并发工作
      void runAgents(taskId).catch((e) => console.error(`[arena] agents failed for ${taskId}:`, e));
    },
  };

  async function runAgents(taskId: string): Promise<void> {
    const task = await tasks.get(taskId);
    if (!task || !ctx.makeRunner) return;
    await Promise.all(
      task.agents.map(async (a, i) => {
        const persona = PERSONAS[i % PERSONAS.length];
        try {
          const result = await ctx.makeRunner!(persona).run(
            { name: a.name, remote: a.remote, token: a.token, instructions: null },
            task.task,
            { taskId, agentIndex: i },
          );
          await withTaskLock(taskId, async () => {
            const cur = await tasks.get(taskId);
            if (!cur) return;
            cur.agents[i].status = "pushed";
            cur.agents[i].commit = result.commit;
            await tasks.save(cur);
            // 模拟 Artifacts push 事件 → 直接触发评审
            await reviewTask(store, tasks, taskId);
          });
        } catch (e) {
          await withTaskLock(taskId, async () => {
            const cur = await tasks.get(taskId);
            if (!cur) return;
            // agent 本体失败（超时/非零退出/无推送）判负；其它异常记为基础设施错误
            cur.agents[i].status = e instanceof AgentFailedError ? "failed" : "error";
            cur.agents[i].error = e instanceof Error ? e.message : String(e);
            await tasks.save(cur);
          });
        }
      }),
    );
    console.log(`[arena] task ${taskId} agents done`);
  }

  const server = createServer(async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
    try {
      const host = nodeReq.headers.host ?? `localhost:${PORT}`;
      const url = new URL(nodeReq.url ?? "/", `http://${host}`);
      const chunks: Buffer[] = [];
      for await (const c of nodeReq) chunks.push(c as Buffer);
      const req = new Request(url.toString(), {
        method: nodeReq.method,
        headers: nodeReq.headers as HeadersInit,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });

      const api = await routeRequest(req, ctx);
      if (api) {
        const headers: Record<string, string> = {};
        api.headers.forEach((v, k) => {
          headers[k] = v;
        });
        nodeRes.writeHead(api.status, headers);
        nodeRes.end(Buffer.from(await api.arrayBuffer()));
        return;
      }

      // 静态资源：public/
      let file = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = join(PUBLIC_DIR, file);
      try {
        const st = await stat(filePath);
        if (!st.isFile()) throw new Error("not a file");
        const data = await readFile(filePath);
        nodeRes.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
        nodeRes.end(data);
      } catch {
        nodeRes.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        nodeRes.end("not found");
      }
    } catch (e) {
      console.error("[arena] request failed:", e);
      nodeRes.writeHead(500, { "content-type": "application/json" });
      nodeRes.end(JSON.stringify({ error: String(e) }));
    }
  });

  server.listen(PORT, () => {
    console.log(`[arena] dev server on http://localhost:${PORT} (mock Artifacts, 无需 Cloudflare 账号)`);
  });
}

void main();
