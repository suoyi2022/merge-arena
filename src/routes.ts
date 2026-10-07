/**
 * routes.ts — 与运行环境无关的路由逻辑。
 * Worker 入口（index.ts）和本地 dev-server 共用这里，Store 切换零改动。
 */
import { PERSONAS, type AgentRunner, type Persona, type Workspace } from "./agent-runner.js";
import { reviewTask } from "./review.js";
import type { ArtifactsStore, TaskRecord, TaskStore } from "./store.js";

export interface RouteContext {
  store: ArtifactsStore;
  tasks: TaskStore;
  /** 创建 agent 执行器（dev 用 ScriptedAgent；生产可返回 null，靠外部 agent）。 */
  makeRunner: ((persona: Persona) => AgentRunner) | null;
  /** 任务创建后的钩子（dev 用来后台跑假 agent；Worker 留空）。 */
  onTaskCreated?: (taskId: string) => void;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function newTaskId(): string {
  return `t${Date.now().toString(36)}`;
}

async function fanOut(
  ctx: RouteContext,
  taskId: string,
  baselineName: string,
  count: number,
): Promise<Workspace[]> {
  const store = ctx.store;
  const baseline = await store.get(baselineName); // 不存在则抛错 → 400
  const { defaultBranch } = await baseline.info();
  const brief = await baseline.readFile({ ref: defaultBranch, path: "AGENTS.md" });
  await baseline[Symbol.asyncDispose]();

  const workspaces: Workspace[] = [];
  for (let i = 0; i < count; i++) {
    const name = `arena-${taskId}-agent-${i}`;
    const h = await store.get(baselineName);
    const forked = await h.fork(name, { defaultBranchOnly: true });
    await h[Symbol.asyncDispose]();
    const wh = await store.get(forked.name);
    const token = await wh.createToken("write", 3600);
    await wh[Symbol.asyncDispose]();
    workspaces.push({
      name: forked.name,
      remote: forked.remote,
      token: token.plaintext,
      instructions: brief,
    });
  }
  return workspaces;
}

export async function routeRequest(req: Request, ctx: RouteContext): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;

  // POST /api/arena — 开赛
  if (path === "/api/arena" && req.method === "POST") {
    let body: { task?: string; repo?: string; agents?: number };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    const taskText = (body.task ?? "").trim();
    if (!taskText) return json({ error: "task 不能为空" }, 400);
    const repo = (body.repo ?? "newsnow-baseline").trim();
    const count = Math.min(Math.max(Number(body.agents) || 3, 1), 8);

    try {
      await ctx.store.get(repo);
    } catch {
      return json({ error: `基线仓库不存在: ${repo}` }, 400);
    }

    const id = newTaskId();
    const workspaces = await fanOut(ctx, id, repo, count);
    const record: TaskRecord = {
      id,
      task: taskText,
      repo,
      createdAt: new Date().toISOString(),
      agents: workspaces.map((w, i) => ({
        name: w.name,
        remote: w.remote,
        token: w.token,
        persona: PERSONAS[i % PERSONAS.length],
        status: "working",
      })),
    };
    await ctx.tasks.save(record);
    ctx.onTaskCreated?.(id);

    return json({
      id,
      workspaces: workspaces.map((w) => ({
        name: w.name,
        remote: w.remote,
        token: w.token,
        instructions: w.instructions,
      })),
    });
  }

  // GET /api/arena/:id — 任务状态（含排行榜）
  const mStatus = /^\/api\/arena\/([^/]+)$/.exec(path);
  if (mStatus && req.method === "GET") {
    const task = await ctx.tasks.get(mStatus[1]);
    if (!task) return json({ error: "task not found" }, 404);
    const leaderboard = task.agents
      .map((a, index) => ({ index, name: a.name, persona: a.persona, status: a.status, score: a.score }))
      .filter((a) => a.score)
      .sort((x, y) => (y.score?.total ?? 0) - (x.score?.total ?? 0));
    return json({ ...task, leaderboard });
  }

  // GET /api/arena/:id/diff?agent=i — fork vs baseline 的文件级差异（供并排对比）
  const mDiff = /^\/api\/arena\/([^/]+)\/diff$/.exec(path);
  if (mDiff && req.method === "GET") {
    const task = await ctx.tasks.get(mDiff[1]);
    if (!task) return json({ error: "task not found" }, 404);
    const i = Number(url.searchParams.get("agent") ?? 0);
    const agent = task.agents[i];
    if (!agent) return json({ error: "agent not found" }, 400);
    const files = await ctx.store.diff(task.repo, agent.name);
    return json({ agent: agent.name, files });
  }

  // POST /api/arena/:id/review — 手动触发评审（事件通道的等价物，方便调试）
  const mReview = /^\/api\/arena\/([^/]+)\/review$/.exec(path);
  if (mReview && req.method === "POST") {
    const ranked = await reviewTask(ctx.store, ctx.tasks, mReview[1]);
    return json({ ranked });
  }

  // POST /api/arena/:id/merge {winner} — 合并冠军进基线 main
  const mMerge = /^\/api\/arena\/([^/]+)\/merge$/.exec(path);
  if (mMerge && req.method === "POST") {
    const task = await ctx.tasks.get(mMerge[1]);
    if (!task) return json({ error: "task not found" }, 404);
    let body: { winner?: number };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    const winner = Number(body.winner);
    const agent = task.agents[winner];
    if (!agent || agent.status !== "scored") {
      return json({ error: "冠军无效或尚未评分" }, 400);
    }
    const { commit } = await ctx.store.merge(task.repo, agent.name);
    task.winner = winner;
    task.mergedCommit = commit;
    await ctx.tasks.save(task);
    return json({ ok: true, winner: agent.name, commit });
  }

  // GET /api/tasks — 历史任务列表
  if (path === "/api/tasks" && req.method === "GET") {
    const tasks = await ctx.tasks.list();
    return json({ tasks: tasks.map((t) => ({ id: t.id, task: t.task, createdAt: t.createdAt })) });
  }

  return null; // 非 API 路由，调用方处理静态资源
}
