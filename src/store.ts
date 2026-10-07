/**
 * store.ts — Merge Arena 的存储抽象层。
 *
 * 所有业务代码只依赖这里的接口。本地开发用 MockArtifactsStore（git 裸仓），
 * 生产环境用 BindingStore 包一层真实的 env.ARTIFACTS，业务逻辑零改动。
 */

// ---------------------------------------------------------------------------
// Artifacts 仓库抽象（按 research/artifacts-brief.md 的 binding 形状）
// ---------------------------------------------------------------------------

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface ForkResult {
  name: string;
  remote: string;
}

export interface TokenResult {
  plaintext: string;
  expiresAt: number;
}

/** 单个仓库的操作句柄。真实 binding 的 handle 要求 `using` 释放，这里统一为 AsyncDisposable。 */
export interface RepoHandle extends AsyncDisposable {
  info(): Promise<{ name: string; remote: string; defaultBranch: string }>;
  fork(name: string, opts?: { defaultBranchOnly?: boolean }): Promise<ForkResult>;
  createToken(scope?: "read" | "write", ttlSeconds?: number): Promise<TokenResult>;
  log(opts?: { ref?: string; limit?: number }): Promise<CommitInfo[]>;
  readFile(opts: { ref: string; path: string }): Promise<string | null>;
  readCommit(hash: string): Promise<CommitInfo | null>;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  base: string | null; // baseline 侧内容
  head: string | null; // fork 侧内容
}

/** Artifacts namespace 级操作。 */
export interface ArtifactsStore {
  get(name: string): Promise<RepoHandle>;
  create(name: string): Promise<ForkResult>;
  importFrom(opts: { url: string; name: string; branch?: string }): Promise<ForkResult>;
  list(): Promise<string[]>;
  /** fork 与 baseline 之间的文件级差异。mock 用本地 git 实现；真实环境用带 token 的 git client 实现。 */
  diff(baseName: string, forkName: string): Promise<FileChange[]>;
  /** 把 fork 的 main 合并进 baseline 的 main，返回合并提交。 */
  merge(baseName: string, forkName: string): Promise<{ commit: string }>;
}

// ---------------------------------------------------------------------------
// 擂台任务状态
// ---------------------------------------------------------------------------

export type AgentStatus = "working" | "pushed" | "scored" | "error" | "failed";

export interface ScoreBreakdown {
  linesChanged: number;
  hasTests: boolean;
  noTodo: boolean;
  total: number;
}

export interface AgentState {
  name: string;
  remote: string;
  token: string;
  persona: string;
  status: AgentStatus;
  commit?: string;
  score?: ScoreBreakdown;
  error?: string;
}

export interface TaskRecord {
  id: string;
  task: string;
  repo: string; // baseline 仓库名
  createdAt: string;
  agents: AgentState[];
  winner?: number;
  mergedCommit?: string;
}

export interface TaskStore {
  save(task: TaskRecord): Promise<void>;
  get(id: string): Promise<TaskRecord | null>;
  list(): Promise<TaskRecord[]>;
}

// ---------------------------------------------------------------------------
// 真实 Artifacts binding 的最小结构类型（npx wrangler types 会生成正式类型，
// 这里按官方文档手写最小形状，仅做结构适配）
// ---------------------------------------------------------------------------

interface RealRepoHandle extends AsyncDisposable {
  info(): Promise<{ defaultBranch: string; [k: string]: unknown }>;
  fork(name: string, opts?: Record<string, unknown>): Promise<{ name: string; remote: string }>;
  createToken(scope?: string, ttl?: number): Promise<{ plaintext: string; expiresAt: number }>;
  log(opts?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  readFile(opts: { ref: string; path: string }): Promise<Blob | null>;
  readCommit(hash: string): Promise<Record<string, unknown> | null>;
  readTree(hash: string): Promise<Array<{ name: string; mode: string; hash: string; type: string }>>;
}

export interface RealArtifactsBinding {
  get(name: string): Promise<RealRepoHandle>;
  create(name: string, opts?: Record<string, unknown>): Promise<{ name: string; remote: string }>;
  import(opts: Record<string, unknown>): Promise<{ name: string; remote: string }>;
  list(opts?: Record<string, unknown>): Promise<Array<{ name: string }>>;
}

/** 防御性释放 handle：真实 binding 可能没实现 AsyncDisposable。 */
async function safeDisposeHandle(h: unknown): Promise<void> {
  const fn = (h as { [Symbol.asyncDispose]?: unknown })[Symbol.asyncDispose];
  if (typeof fn === "function") await (fn as () => Promise<void>).call(h);
}

/** 递归列出 tree 下所有文件：path -> blob hash。 */
async function listAllFiles(
  h: RealRepoHandle,
  treeHash: string,
  prefix = "",
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = await h.readTree(treeHash);
  for (const e of entries) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.type === "tree" || e.mode === "40000") {
      for (const [p, hh] of await listAllFiles(h, e.hash, path)) out.set(p, hh);
    } else if (e.type === "blob") {
      out.set(path, e.hash);
    }
  }
  return out;
}

/** 把真实 env.ARTIFACTS 适配成 ArtifactsStore。Worker 入口只用这一行做切换。 */
export class BindingStore implements ArtifactsStore {
  constructor(private binding: RealArtifactsBinding) {}

  async get(name: string): Promise<RepoHandle> {
    const h = await this.binding.get(name);
    return {
      info: async () => {
        const i = await h.info();
        return { name, remote: "", defaultBranch: String(i.defaultBranch ?? "main") };
      },
      fork: (n, opts) => h.fork(n, { defaultBranchOnly: opts?.defaultBranchOnly ?? true }),
      createToken: (scope = "write", ttl = 3600) => h.createToken(scope, ttl),
      log: async (opts) => {
        const rows = await h.log({ ref: opts?.ref ?? "main", limit: opts?.limit ?? 50 });
        return rows.map((r) => ({
          hash: String(r.hash ?? r.sha ?? ""),
          message: String(r.message ?? ""),
          author: String(r.author ?? ""),
          date: String(r.date ?? ""),
        }));
      },
      readFile: async (opts) => {
        const blob = await h.readFile(opts);
        return blob ? await blob.text() : null;
      },
      readCommit: async (hash) => {
        const c = await h.readCommit(hash);
        return c ? { hash, message: String(c.message ?? ""), author: "", date: "" } : null;
      },
      [Symbol.asyncDispose]: async () => {
        // 真实 binding 的 handle 可能没有实现 AsyncDisposable（类型声明与实际不符），防御性调用
        const fn = (h as unknown as { [Symbol.asyncDispose]?: unknown })[Symbol.asyncDispose];
        if (typeof fn === "function") await (fn as () => Promise<void>).call(h);
      },
    };
  }

  async create(name: string): Promise<ForkResult> {
    return this.binding.create(name);
  }

  async importFrom(opts: { url: string; name: string; branch?: string }): Promise<ForkResult> {
    const r = await this.binding.import({
      source: { url: opts.url, branch: opts.branch ?? "main" },
      target: { name: opts.name },
    });
    return { name: r.name, remote: r.remote };
  }

  async list(): Promise<string[]> {
    const repos = await this.binding.list();
    return repos.map((r) => r.name);
  }

  /** 真实 diff：递归比较两棵 tree，按 blob hash 找出差异文件并读出内容。 */
  async diff(baselineName: string, forkName: string): Promise<FileChange[]> {
    const bHandle = await this.binding.get(baselineName);
    const fHandle = await this.binding.get(forkName);
    try {
      const [bInfo, fInfo] = await Promise.all([bHandle.info(), fHandle.info()]);
      const [bLog, fLog] = await Promise.all([
        bHandle.log({ ref: bInfo.defaultBranch, limit: 1 }),
        fHandle.log({ ref: fInfo.defaultBranch, limit: 1 }),
      ]);
      const bTree = String((bLog[0] as { treeHash: string }).treeHash);
      const fTree = String((fLog[0] as { treeHash: string }).treeHash);
      if (!bTree || !fTree) throw new Error("无法读取 treeHash");
      if (bTree === fTree) return [];
      const [bFiles, fFiles] = await Promise.all([
        listAllFiles(bHandle, bTree),
        listAllFiles(fHandle, fTree),
      ]);
      const changes: FileChange[] = [];
      for (const p of new Set([...bFiles.keys(), ...fFiles.keys()])) {
        const bh = bFiles.get(p);
        const fh = fFiles.get(p);
        if (bh === fh) continue;
        const status = !bh ? "added" : !fh ? "deleted" : "modified";
        const [bBlob, fBlob] = await Promise.all([
          bh ? bHandle.readFile({ ref: bInfo.defaultBranch, path: p }) : Promise.resolve(null),
          fh ? fHandle.readFile({ ref: fInfo.defaultBranch, path: p }) : Promise.resolve(null),
        ]);
        const [base, head] = await Promise.all([
          bBlob ? bBlob.text().catch(() => null) : Promise.resolve(null),
          fBlob ? fBlob.text().catch(() => null) : Promise.resolve(null),
        ]);
        changes.push({ path: p, status, base, head });
      }
      return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
    } finally {
      await safeDisposeHandle(bHandle);
      await safeDisposeHandle(fHandle);
    }
  }

  /**
   * merge：返回 winner fork 的 HEAD commit。
   * 语义：擂台采用"胜者为王"模型 —— winner 的 fork 即为新的基线（tournament 晋级）。
   * 如需把文件级变更写回原基线仓库，请用返回的 token 在外部 git client 执行 merge 后 push。
   */
  async merge(_baseName: string, forkName: string): Promise<{ commit: string }> {
    const h = await this.binding.get(forkName);
    try {
      const info = await h.info();
      const rows = await h.log({ ref: info.defaultBranch, limit: 1 });
      const hash = String((rows[0] as { hash: string }).hash ?? "");
      if (!hash) throw new Error(`无法读取 ${forkName} 的 HEAD`);
      return { commit: hash };
    } finally {
      await safeDisposeHandle(h);
    }
  }
}

// ---------------------------------------------------------------------------
// TaskStore 实现
// ---------------------------------------------------------------------------

/** 内存版：Worker 环境默认（无文件系统）。生产请实现 KV/D1 版。 */
export class MemoryTaskStore implements TaskStore {
  private map = new Map<string, TaskRecord>();
  async save(task: TaskRecord): Promise<void> {
    this.map.set(task.id, structuredClone(task));
  }
  async get(id: string): Promise<TaskRecord | null> {
    const t = this.map.get(id);
    return t ? structuredClone(t) : null;
  }
  async list(): Promise<TaskRecord[]> {
    return [...this.map.values()].map((t) => structuredClone(t));
  }
}

/** KV 版：生产环境用。任务状态跨 isolate、跨部署持久化（内存版在多 isolate/重新部署后会丢任务）。 */
export interface KVNamespaceLike {
  get(key: string, opts?: { type: "json" }): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }>;
}

export class KVTaskStore implements TaskStore {
  constructor(
    private kv: KVNamespaceLike,
    private prefix = "task:",
  ) {}
  async save(task: TaskRecord): Promise<void> {
    await this.kv.put(this.prefix + task.id, JSON.stringify(task));
  }
  async get(id: string): Promise<TaskRecord | null> {
    const v = await this.kv.get(this.prefix + id, { type: "json" });
    return (v as TaskRecord | null) ?? null;
  }
  async list(): Promise<TaskRecord[]> {
    const { keys } = await this.kv.list({ prefix: this.prefix });
    const out: TaskRecord[] = [];
    for (const k of keys) {
      const v = await this.kv.get(k.name, { type: "json" });
      if (v) out.push(v as TaskRecord);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}

/** 文件版：仅本地开发（node 有 fs）。数据落在 ./data/tasks/<id>.json */
export class FileTaskStore implements TaskStore {
  constructor(private dir: string) {}

  private async ensureDir(): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(this.dir, { recursive: true });
  }

  private path(id: string): string {
    return `${this.dir}/${id}.json`;
  }

  async save(task: TaskRecord): Promise<void> {
    await this.ensureDir();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(this.path(task.id), JSON.stringify(task, null, 2), "utf8");
  }

  async get(id: string): Promise<TaskRecord | null> {
    try {
      const { readFile } = await import("node:fs/promises");
      return JSON.parse(await readFile(this.path(id), "utf8")) as TaskRecord;
    } catch {
      return null;
    }
  }

  async list(): Promise<TaskRecord[]> {
    try {
      const { readdir, readFile } = await import("node:fs/promises");
      const files = await readdir(this.dir);
      const out: TaskRecord[] = [];
      for (const f of files.filter((x) => x.endsWith(".json"))) {
        try {
          out.push(JSON.parse(await readFile(`${this.dir}/${f}`, "utf8")) as TaskRecord);
        } catch {
          /* 跳过损坏文件 */
        }
      }
      return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    } catch {
      return [];
    }
  }
}
