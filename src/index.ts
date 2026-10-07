/**
 * index.ts — Cloudflare Worker 入口。
 *
 * 真实部署：env.ARTIFACTS 由 wrangler.jsonc 的 artifacts binding 注入
 * （namespace "merge-arena"，需 Workers Paid plan）。
 * 任务状态默认放内存；生产请在 wrangler.jsonc 加 KV/D1 绑定并实现 TaskStore。
 */
import { routeRequest, type RouteContext } from "./routes.js";
import { handlePushEvent, type ArtifactsPushEvent } from "./review.js";
import { BindingStore, MemoryTaskStore, type RealArtifactsBinding } from "./store.js";

// npx wrangler types 会生成正式的 Env；这里按需手写最小形状
interface Fetcher {
  fetch(req: Request): Promise<Response>;
}
interface QueueMessage<T = unknown> {
  body: T;
}
interface MessageBatch<T = unknown> {
  messages: QueueMessage<T>[];
}

export interface Env {
  ARTIFACTS: RealArtifactsBinding;
  ASSETS: Fetcher;
}

function makeContext(env: Env): RouteContext {
  return {
    store: new BindingStore(env.ARTIFACTS),
    tasks: new MemoryTaskStore(),
    makeRunner: null, // 生产环境 agent 是外部进程，不在 Worker 内跑
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const ctx = makeContext(env);
    const api = await routeRequest(req, ctx);
    if (api) return api;
    // 非 API 请求交给静态资源（public/）
    return env.ASSETS.fetch(req);
  },

  /**
   * Queue 消费者（兜底路径）：消费 Artifacts 推送事件，触发评审。
   * 若启用 wrangler.jsonc 里的 direct triggers（path A），事件会直接打到
   * Workflow；同样调 handlePushEvent，保持单一入口。
   */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const ctx = makeContext(env);
    for (const msg of batch.messages) {
      const e = msg.body as ArtifactsPushEvent;
      if (!e || e.type !== "cf.artifacts.repo.pushed") continue;
      await handlePushEvent(ctx.store, ctx.tasks, e);
    }
  },
};
