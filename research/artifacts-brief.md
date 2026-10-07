# Cloudflare Artifacts 技术简报（Merge Arena 构建用）

> 调研日期：2026-10-07。Artifacts 处于 open beta。以下 API 形状以官方文档为准，构建时以 `npx wrangler types` 生成的类型为最终依据。

## 1. 概览与前置条件

- Artifacts = Git 兼容的版本化存储，三个使用面：**Workers binding**（`env.ARTIFACTS`）、**REST 控制面**、**标准 Git-over-HTTPS remote**。
- 前置：**Workers Paid plan**（$5/月）。Dashboard 要求账号角色具备 Artifacts Read + Artifacts Edit 权限。
- 计费：按**仓库操作数 + 存储数据量**计费；**2026-10-15 起开始收费**（比赛 10-14 截止，比赛期内免费）。

## 2. Namespace（REST + Dashboard）

Base URL（账号级）：

```
https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts
```

仓库级 base：`.../artifacts/namespaces/$NAMESPACE`

| 操作 | 路由 |
|---|---|
| 创建 namespace | `POST /artifacts/namespaces` |
| 列出 namespace | `GET /artifacts/namespaces?limit=&cursor=` |
| 查 namespace | `GET /artifacts/namespaces/:namespace` |

创建 namespace（含 jurisdiction）：

```bash
curl --request POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts/namespaces" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"namespace":"merge-arena","jurisdiction":"us"}'
# jurisdiction: "eu" | "us"，可选，默认 unrestricted；创建后不可更改
```

- Dashboard 也可创建 namespace（Workers & Pages 相关入口）。
- 仓库路由：`POST /artifacts/namespaces/:ns/repos`（建仓）、`POST .../repos/:name/fork`（body: `name`, `description?`, `read_only?`, `default_branch_only?`）、`POST .../repos/:name/import`（body: `url`, `branch?`, `depth?`，从 GitHub 等 HTTPS remote 导入）、`GET .../repos`（列表）、`DELETE .../repos/:name`（202 Accepted）。
- 建仓/fork/import 的返回里直接带 `remote` + `token`（token 即过期时间缀在 `?expires=` 里）。
- Token 管理：`POST /artifacts/namespaces/:ns/tokens`（body: `repo`, `scope: "read"|"write"` 默认 write, `ttl` 秒，60s–1年，默认 86400）；`GET .../tokens`；`DELETE .../tokens/:id`。
- 读内容：`GET .../repos/:name/log?ref=&limit=&offset=`、`.../commit/:hash`、`.../tree/:hash`、`.../blob/:hash`、`.../file?ref=&path=`、`.../raw/:ref/:path`。

## 3. Workers Binding API（`env.ARTIFACTS`）

wrangler 配置（`wrangler.jsonc`）：

```jsonc
{
  "artifacts": [{ "binding": "ARTIFACTS", "namespace": "merge-arena" }]
  // 本地 dev 可选： "remote": true  // 用远端 Artifacts 服务
}
```

`npx wrangler types` 后：`env.ARTIFACTS: Artifacts`。

**Namespace 方法**（`env.ARTIFACTS.*`）：

| 方法 | 说明 |
|---|---|
| `create(name, {readOnly?, description?, setDefaultBranch?})` | 建仓，返回 `{name, remote, defaultBranch, token}` |
| `get(name)` | 取 disposable repo handle；**必须 `using` 声明**；仓库不存在/未就绪时抛错 |
| `list({limit?, cursor?})` | 列表，repo 带 `status: ready \| importing \| forking` |
| `import({source:{url, branch?, depth?}, target:{name, opts?}})` | 从外部 Git remote 导入 |
| `delete(name)` | 删仓，返回 boolean |

**Repo handle 方法**（`using repo = await env.ARTIFACTS.get(name)`）：

| 方法 | 说明 |
|---|---|
| `info()` | 元数据（含 remote）；属性不直接暴露，每次 fresh lookup |
| `createToken(scope?, ttl?)` | scope 默认 `"write"`；ttl 秒；返回 `{plaintext, expiresAt}`（plaintext 即 Git token） |
| `listTokens()` / `revokeToken(tokenOrId)` / `validateToken(token)` | token 生命周期管理 |
| `fork(name, {description?, readOnly?, defaultBranchOnly?})` | fork，返回新仓 `{name, remote, ...}` |
| `log({ref?, limit?, offset?})` | 提交历史（first-parent 链，新→旧；ref 默认 HEAD，limit 默认 50，最大 1000） |
| `readCommit(hash)` / `readTree(hash)` / `readBlob(hash)` | 按 SHA-1 读对象（不存在返回 null） |
| `readFile({ref, path})` | 按分支/tag/commit + 路径读文件，返回 MIME-typed Blob（不存在返回 null；ref/path 为空抛 INVALID_INPUT） |

**擂台核心片段（Worker 内 fork + 发 agent token）：**

```ts
interface Env { ARTIFACTS: Artifacts }

async function fanOut(env: Env, taskId: string, agentCount = 3) {
  using project = await env.ARTIFACTS.get("newsnow-baseline");
  const { defaultBranch } = await project.info();
  const brief = await project.readFile({ ref: defaultBranch, path: "AGENTS.md" });

  return Promise.all(Array.from({ length: agentCount }, async (_, i) => {
    const name = `arena-${taskId}-agent-${i}`;
    const forked = await project.fork(name, { defaultBranchOnly: true });
    using ws = await env.ARTIFACTS.get(forked.name);
    const token = await ws.createToken("write", 3600); // 1 小时写 token
    return { name, remote: forked.remote, token: token.plaintext,
             instructions: brief ? await brief.text() : null };
  }));
}
```

## 4. 事件订阅（push → 自动评审流水线）

Artifacts 会发布仓库事件：created / imported / forked / deleted / **pushed** / cloned / fetched。

**路径 A（推荐）：direct triggers，无需 Queue**（需 wrangler ≥ 4.118，PR #14919）：

```jsonc
{
  "triggers": {
    "events": [{
      "type": "cf.artifacts.repo.pushed",
      "filter": { "namespace": "merge-arena", "repo_name": "arena-*"
...[truncated 4095 chars]