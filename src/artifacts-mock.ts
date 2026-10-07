/**
 * artifacts-mock.ts — Artifacts binding 的本地 mock。
 *
 * 用 ./data/mock-repos/ 下的 git 裸仓模拟 Artifacts 仓库，实现 ArtifactsStore
 * 接口的子集。Worker 业务代码只依赖接口，换真实 binding 时零改动。
 *
 * 注意：这只是开发联调用的近似实现（token 不做鉴权、事件靠直接调用）。
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { simpleGit, type SimpleGit } from "simple-git";
import type {
  ArtifactsStore,
  CommitInfo,
  FileChange,
  ForkResult,
  RepoHandle,
  TokenResult,
} from "./store.js";

const execFileAsync = promisify(execFile);

export class MockArtifactsStore implements ArtifactsStore {
  constructor(private root: string) {}

  private repoPath(name: string): string {
    return join(this.root, `${name}.git`);
  }

  private gitAt(dir: string): SimpleGit {
    return simpleGit({ baseDir: dir, binary: "git", trimmed: true });
  }

  /** 确保根目录存在。 */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async exists(name: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["--git-dir", this.repoPath(name), "rev-parse", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  async get(name: string): Promise<RepoHandle> {
    if (!(await this.exists(name))) {
      throw new Error(`repo not found or not ready: ${name}`);
    }
    const store = this;
    const repoPath = this.repoPath(name);
    return {
      info: async () => ({ name, remote: repoPath, defaultBranch: "main" }),
      fork: (n, opts) => store.forkFrom(name, n, opts),
      createToken: async (_scope = "write", ttl = 3600): Promise<TokenResult> => ({
        // mock token：仅做透传标识，不做鉴权
        plaintext: `mock_${name}_${Date.now().toString(36)}`,
        expiresAt: Date.now() + ttl * 1000,
      }),
      log: async (opts): Promise<CommitInfo[]> => {
        const ref = opts?.ref ?? "main";
        const limit = opts?.limit ?? 50;
        const git = store.gitAt(repoPath);
        const raw = await git.raw([
          "--git-dir",
          repoPath,
          "log",
          ref,
          `-n${limit}`,
          "--format=%H%x1f%s%x1f%an%x1f%ad%x1e",
          "--date=iso",
        ]);
        return raw
          .split("\x1e")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((line) => {
            const [hash, message, author, date] = line.split("\x1f");
            return { hash, message, author, date };
          });
      },
      readFile: async (opts): Promise<string | null> => {
        try {
          const { stdout } = await execFileAsync("git", [
            "--git-dir",
            repoPath,
            "show",
            `${opts.ref}:${opts.path}`,
          ]);
          return stdout;
        } catch {
          return null;
        }
      },
      readCommit: async (hash: string): Promise<CommitInfo | null> => {
        try {
          const git = store.gitAt(repoPath);
          const raw = await git.raw([
            "--git-dir",
            repoPath,
            "show",
            "-s",
            "--format=%H%x1f%s%x1f%an%x1f%ad",
            "--date=iso",
            hash,
          ]);
          const [h, message, author, date] = raw.trim().split("\x1f");
          return { hash: h, message, author, date };
        } catch {
          return null;
        }
      },
      [Symbol.asyncDispose]: async () => {
        /* mock 无需释放 */
      },
    };
  }

  async create(name: string): Promise<ForkResult> {
    const p = this.repoPath(name);
    await execFileAsync("git", ["init", "--bare", "-b", "main", p]);
    return { name, remote: p };
  }

  private async forkFrom(
    src: string,
    name: string,
    opts?: { defaultBranchOnly?: boolean },
  ): Promise<ForkResult> {
    const dst = this.repoPath(name);
    await rm(dst, { recursive: true, force: true });
    const args = ["clone", "--bare"];
    if (opts?.defaultBranchOnly !== false) args.push("--single-branch", "--branch", "main");
    args.push(this.repoPath(src), dst);
    await execFileAsync("git", args);
    return { name, remote: dst };
  }

  async importFrom(opts: { url: string; name: string; branch?: string }): Promise<ForkResult> {
    // 本地 mock：把 url 当作本地路径或远程地址直接 clone
    const dst = this.repoPath(opts.name);
    await rm(dst, { recursive: true, force: true });
    await execFileAsync("git", [
      "clone",
      "--bare",
      "--single-branch",
      "--branch",
      opts.branch ?? "main",
      opts.url,
      dst,
    ]);
    return { name: opts.name, remote: dst };
  }

  async list(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    try {
      const files = await readdir(this.root);
      return files.filter((f) => f.endsWith(".git")).map((f) => f.slice(0, -4));
    } catch {
      return [];
    }
  }

  /** 用 base 仓的 git dir 直接 diff 两个分支（跨裸仓：先 fetch fork 进来）。 */
  async diff(baseName: string, forkName: string): Promise<FileChange[]> {
    const base = this.repoPath(baseName);
    const fork = this.repoPath(forkName);
    const tmpRef = `refs/__arena_head_${Date.now().toString(36)}`;
    await execFileAsync("git", ["--git-dir", base, "fetch", fork, `main:${tmpRef}`]);
    try {
      const git = this.gitAt(base);
      const nameStatus = await git.raw([
        "--git-dir",
        base,
        "diff",
        "--name-status",
        `main...${tmpRef}`,
      ]);
      const changes: FileChange[] = [];
      for (const line of nameStatus.split("\n").map((s) => s.trim()).filter(Boolean)) {
        const [code, path] = line.split(/\s+/, 2);
        const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
        const [baseContent, headContent] = await Promise.all([
          status === "added"
            ? Promise.resolve(null)
            : execFileAsync("git", ["--git-dir", base, "show", `main:${path}`])
                .then((r) => r.stdout)
                .catch(() => null),
          status === "deleted"
            ? Promise.resolve(null)
            : execFileAsync("git", ["--git-dir", base, "show", `${tmpRef}:${path}`])
                .then((r) => r.stdout)
                .catch(() => null),
        ]);
        changes.push({ path, status, base: baseContent, head: headContent });
      }
      return changes;
    } finally {
      await execFileAsync("git", ["--git-dir", base, "update-ref", "-d", tmpRef]).catch(() => {});
    }
  }

  /** 把 fork 的 main 合并进 baseline 的 main（mock：在临时工作区里 merge 后 push）。 */
  async merge(baseName: string, forkName: string): Promise<{ commit: string }> {
    const base = this.repoPath(baseName);
    const fork = this.repoPath(forkName);
    const work = await mkdtemp(join(tmpdir(), "arena-merge-"));
    try {
      const git = simpleGit({ baseDir: work, binary: "git", trimmed: true });
      await git.clone(base, ".");
      await git.addConfig("user.name", "arena-merger");
      await git.addConfig("user.email", "arena@example.com");
      await git.raw(["fetch", fork, "main:refs/remotes/fork/main"]);
      await git.raw(["merge", "--no-ff", "-m", `arena: merge winner ${forkName}`, "refs/remotes/fork/main"]);
      await git.push("origin", "main");
      const commit = await git.revparse(["HEAD"]);
      return { commit };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** 建一个带初始提交的演示基线仓（dev-server 首次启动时调用）。 */
  async seedBaseline(name: string, files: Record<string, string>): Promise<void> {
    if (await this.exists(name)) return;
    await this.create(name);
    const work = await mkdtemp(join(tmpdir(), "arena-seed-"));
    try {
      const git = simpleGit({ baseDir: work, binary: "git", trimmed: true });
      await git.clone(this.repoPath(name), ".");
      await git.addConfig("user.name", "arena");
      await git.addConfig("user.email", "arena@example.com");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      for (const [p, content] of Object.entries(files)) {
        await mkdir(join(work, dirname(p)), { recursive: true });
        await writeFile(join(work, p), content, "utf8");
      }
      await git.add(".");
      await git.commit("chore: seed baseline");
      await git.push("origin", "main");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
