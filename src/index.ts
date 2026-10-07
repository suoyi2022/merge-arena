/**
 * index.ts — Cloudflare Worker 入口。
 *
 * 真实部署：env.ARTIFACTS 由 wrangler.jsonc 的 artifacts binding 注入
 * （namespace "merge-arena"，需 Workers Paid plan）。
 * 任务状态默认放内存；生产请在 wrangler.jsonc 加 KV/D1 绑定并实现 TaskStore。
 */
import { routeRequest, type RouteContext } from "./routes.js";
import { handlePushEvent, type ArtifactsPushEvent } from "./review.js";
import { BindingStore, KVTaskStore, MemoryTaskStore, type KVNamespaceLike, type RealArtifactsBinding } from "./store.js";

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
  TASKS?: KVNamespaceLike;
}

function makeContext(env: Env): RouteContext {
  return {
    store: new BindingStore(env.ARTIFACTS),
    // KV 未配置时回退到内存（任务在 isolate 回收/重部署后丢失，仅适合单实例演示）
    tasks: env.TASKS ? new KVTaskStore(env.TASKS) : new MemoryTaskStore(),
    makeRunner: null, // 生产环境 agent 是外部进程，不在 Worker 内跑
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // 管理端点：诊断 ARTIFACTS binding 是否可用（只读）
    if (url.pathname === "/api/diag" && req.method === "GET") {
      try {
        const raw = (await env.ARTIFACTS.list({ limit: 20 })) as unknown;
        const repos = Array.isArray(raw)
          ? raw
          : ((raw as Record<string, unknown>).repos as Array<Record<string, unknown>> | undefined) ??
            [];
        return Response.json({
          ok: true,
          binding: "ok",
          rawType: Array.isArray(raw) ? "array" : typeof raw,
          rawKeys: !Array.isArray(raw) && raw ? Object.keys(raw as object) : undefined,
          repos: repos.map((r) => ({ name: String(r.name), status: String(r.status ?? "") })),
        });
      } catch (e) {
        return Response.json(
          { ok: false, binding: "error", error: String((e as Error)?.message ?? e) },
          { status: 500 },
        );
      }
    }

    // 管理端点：一键初始化基线仓库（幂等：已存在则跳过）
    if (url.pathname === "/api/admin/setup" && req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as { url?: string; name?: string };
        const name = body.name || "newsnow-baseline";
        // 存在性探测：get() 成功即存在，抛错即不存在（不依赖 handle 的 dispose）
        let exists = false;
        try {
          await env.ARTIFACTS.get(name);
          exists = true;
        } catch {
          exists = false;
        }
        if (exists) return Response.json({ ok: true, skipped: true, name });
        const sourceUrl = body.url || "https://github.com/suoyi2022/newsnow";
        const result = await env.ARTIFACTS.import({
          source: { url: sourceUrl },
          target: { name },
        });
        return Response.json({ ok: true, importing: true, name, result });
      } catch (e) {
        return Response.json(
          { ok: false, error: String((e as Error)?.message ?? e) },
          { status: 500 },
        );
      }
    }

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
