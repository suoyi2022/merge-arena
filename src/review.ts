/**
 * review.ts — 评审打分（确定性、可解释的 stub）。
 *
 * 真实部署里这里可以换成 LLM 裁判 / 跑测试 / lint；但“可解释”是擂台的核心，
 * 所以打分维度保持透明：改动规模（封顶）+ 有无测试 + 有无 TODO。
 */
import type { ArtifactsStore, ScoreBreakdown, TaskRecord, TaskStore } from "./store.js";

const TEST_RE = /(^|\/)(test|tests|__tests__|spec)\//i;
const TODO_RE = /\b(TODO|FIXME|XXX|HACK)\b/;

export async function scoreAgent(
  store: ArtifactsStore,
  baselineName: string,
  forkName: string,
): Promise<ScoreBreakdown> {
  const changes = await store.diff(baselineName, forkName);
  let lines = 0;
  let hasTests = false;
  let noTodo = true;
  for (const c of changes) {
    if (TEST_RE.test(c.path)) hasTests = true;
    const text = `${c.base ?? ""}\n${c.head ?? ""}`;
    if (TODO_RE.test(text)) noTodo = false;
    // 行数差异的近似：两边行数差的绝对值 + min(两边行数, …) 的简化版
    const b = (c.base ?? "").split("\n").length;
    const h = (c.head ?? "").split("\n").length;
    lines += Math.abs(h - b) + Math.min(b, h) / 10;
  }
  const linesChanged = Math.round(lines);
  const capped = Math.min(linesChanged, 200);
  const total = capped + (hasTests ? 50 : 0) + (noTodo ? 20 : 0);
  return { linesChanged, hasTests, noTodo, total };
}

export interface RankedAgent {
  index: number;
  name: string;
  score: ScoreBreakdown;
}

/** 给任务里所有已 push 的 agent 打分并落盘，返回排行榜。 */
export async function reviewTask(
  store: ArtifactsStore,
  tasks: TaskStore,
  taskId: string,
): Promise<RankedAgent[]> {
  const task = await tasks.get(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  const ranked: RankedAgent[] = [];
  for (let i = 0; i < task.agents.length; i++) {
    const a = task.agents[i];
    if (a.status !== "pushed" && a.status !== "scored") continue;
    const score = await scoreAgent(store, task.repo, a.name);
    a.score = score;
    a.status = "scored";
    ranked.push({ index: i, name: a.name, score });
  }
  ranked.sort((x, y) => y.score.total - x.score.total);
  await tasks.save(task);
  return ranked;
}

/** Artifacts push 事件 payload（按官方文档形状）。 */
export interface ArtifactsPushEvent {
  type: string;
  source: { namespace: string; repoName: string };
  payload: { ref: string; after: string };
}

/**
 * push 事件入口：找到该 fork 所属的任务，把对应 agent 标为 pushed 并触发评分。
 * Queue consumer 和 direct triggers 都调这一个函数。
 */
export async function handlePushEvent(
  store: ArtifactsStore,
  tasks: TaskStore,
  event: ArtifactsPushEvent,
): Promise<void> {
  if (event.type !== "cf.artifacts.repo.pushed") return;
  const repoName = event.source.repoName;
  // 约定：擂台 fork 命名为 arena-<taskId>-agent-<i>
  const m = /^arena-(.+)-agent-(\d+)$/.exec(repoName);
  if (!m) return;
  const [, taskId, idxStr] = m;
  const task: TaskRecord | null = await tasks.get(taskId);
  if (!task) return;
  const agent = task.agents[Number(idxStr)];
  if (!agent) return;
  agent.status = "pushed";
  agent.commit = event.payload.after;
  await tasks.save(task);
  await reviewTask(store, tasks, taskId);
}
