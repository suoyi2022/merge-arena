# 合并擂台 Merge Arena

同一个需求，多个 agent 并发实现，并排评审，一键合并冠军。

为 Cloudflare 「下一代 Git 平台」比赛而建，基于 **Cloudflare Workers + Artifacts**（Git 兼容的版本化存储）。

## 它解决什么

- 多个 agent 同时改同一个代码库时：谁改了什么、哪个方案更好、最后合谁的？
- 传统 PR 是串行的、给人看的；擂台是并行的、给 agent 时代的：**fork 出 N 个工作区 → agent 并发开工 → push 自动触发评审 → 并排对比 → 一键合并冠军**。

## 本地运行（无需 Cloudflare 账号）

```bash
cd ~/workspace/build/arena
npm install
npm run dev
# 打开 http://localhost:8787
```

本地模式用 `src/artifacts-mock.ts`（`./data/mock-repos/` 下的 git 裸仓）模拟 Artifacts，
并用 `ScriptedAgent`（三种 persona：thorough / plain / sloppy）模拟 agent 并发干活，
足够端到端验证：开赛 → 三条实况 lane → 并排 diff → 排行榜 → 合并冠军。

## 架构

```
public/index.html          擂台 UI（单文件，无构建）
src/index.ts               Worker 入口（fetch + queue 消费者）
src/routes.ts              路由逻辑（Worker / 本地共用）
src/store.ts               存储抽象：ArtifactsStore / TaskStore 接口
src/artifacts-mock.ts      本地 mock（git 裸仓实现 ArtifactsStore）
src/agent-runner.ts        AgentRunner 接口 + ScriptedAgent（本地假 agent）
src/cli-agent-runner.ts    CliAgentRunner：通过任意 coding-agent CLI 跑真实 agent
src/review.ts              确定性打分 + push 事件入口 handlePushEvent
src/dev-server.ts          本地 node 开发服务器
arena.config.json          agent 选择（scripted/cli）与 CLI 命令模板配置
```

所有业务代码只依赖 `ArtifactsStore` 接口。`BindingStore`（store.ts）把真实的
`env.ARTIFACTS` 适配成同一接口——换真实环境时业务逻辑零改动。

## 切换到真实 Artifacts

1. 开通 **Workers Paid plan**（$5/月；Artifacts 要求）。
2. 创建 namespace（Dashboard 或 API）：
   ```bash
   curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts/namespaces" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     -H "Content-Type: application/json" \
     --data '{"namespace":"merge-arena"}'
   ```
3. 导入基线仓库（二选一）：
   - `wrangler.jsonc` 的 artifacts binding 配好后，`POST /api/arena` 前先调一次导入接口（待实现），或
   - 在 Worker 里调 `env.ARTIFACTS.import({source:{url:"https://github.com/你/newsnow"}, target:{name:"newsnow-baseline"}})`。
4. `npx wrangler types` 生成正式 Env 类型，`npm run deploy`。

事件链路：agent push → `cf.artifacts.repo.pushed` →（direct triggers / Queue）→
`handlePushEvent`（review.ts）→ 打分落盘 → UI 轮询展示。

## 接入真实 coding agent

`CliAgentRunner`（src/cli-agent-runner.ts）通过**任意 coding-agent CLI** 运行擂台
agent——你不需要改代码，只改配置。`arena.config.json` 里把 `agent.kind` 从
`"scripted"`（默认，零依赖可跑通）切到 `"cli"` 即可：

```json
{
  "agent": {
    "kind": "cli",
    "command": "my-agent-cli",
    "args": ["run", "--prompt", "$ARENA_TASK", "--cwd", "$ARENA_WORKSPACE_DIR"],
    "timeoutMs": 1200000
  }
}
```

也可以用完整 shell 模板（`template` 与 `command`/`args` 二选一，`template` 优先）：

```json
{
  "agent": {
    "kind": "cli",
    "command": "my-agent-cli",
    "template": "echo $ARENA_TASK | {agent} --stdin --cwd $ARENA_WORKSPACE_DIR"
  }
}
```

> template 里直接写裸 `$VAR`，不要自己加引号——runner 会自动做 shell 转义；
> 自己加了引号反而会错。

### 环境变量契约

runner 在启动 CLI 前注入以下环境变量，CLI 通过它们拿到工作区信息：

| 变量 | 说明 |
|---|---|
| `ARENA_GIT_REMOTE` | 工作区 git remote（真实环境是 Artifacts 的 HTTPS 地址） |
| `ARENA_GIT_TOKEN` | 该工作区的短期写 token（已注入 clone 地址，可直接 push） |
| `ARENA_TASK` | 本次擂台任务描述 |
| `ARENA_WORKSPACE_DIR` | 已 clone 好的工作目录，agent 直接在这里干活 |
| `ARENA_AGENT_INDEX` | agent 编号（0,1,2…） |
| `ARENA_WORKSPACE_NAME` | 工作区名 |

模板里的 `$VAR` / `${VAR}` 会被替换，`{agent}` 会被替换为 `command`。
`args` 模式按字面替换（不经过 shell，更安全）；`template` 模式经 `sh -c`
执行，值会自动加 shell 引号。

### 例子

例 1：某个假设的 CLI，prompt 走 flag（`acme-agent` 为占位名，换成你实际用的 CLI）：

```json
{
  "agent": {
    "kind": "cli",
    "command": "acme-agent",
    "args": ["--task", "$ARENA_TASK", "--workdir", "$ARENA_WORKSPACE_DIR", "--non-interactive"]
  }
}
```

例 2：prompt 走 stdin（用 template + shell 管道把任务描述喂进去）：

```json
{
  "agent": {
    "kind": "cli",
    "command": "acme-agent",
    "template": "echo $ARENA_TASK | {agent} --stdin --cwd $ARENA_WORKSPACE_DIR --yes"
  }
}
```

### agent 需要遵守的约定

1. **只在 `$ARENA_WORKSPACE_DIR` 内工作**，不要碰其它 agent 的工作区。
2. 完成后 **`git push origin main`**（remote 已配好带 token 的地址，直接 push 即可，
   不需要自己处理鉴权）。
3. 判负规则（状态记为 `failed`，原因写入任务记录，UI 上显示“失败”）：
   - 超时（默认 20 分钟，`timeoutMs` 可调，进程组会被整体杀掉）；
   - CLI 非零退出（日志尾部会附在原因里）；
   - 退出后 `git ls-remote` 发现远端没有新提交（跑完了但没 push 也算输）。
   完整进程日志在 `data/logs/arena-<taskId>-agent-<i>.log`（`logDir` 可改）。
4. 想拿高分：保持改动聚焦、顺手补测试、不要留 TODO——评审打分就看这些。

> 进阶：也可以完全自己实现 `AgentRunner` 接口（`run(workspace, task, opts?)`，
> 见 agent-runner.ts 顶部注释）。`POST /api/arena` 返回的 `workspaces` 数组
> （`{name, remote, token, instructions}`）就是发给外部编排器的载荷——
> Worker 本体不跑 agent，只负责发工作区、收 push 事件、做评审。

## 尚未接线的部分（真实环境待办）

- `BindingStore.diff/merge`：真实环境用带 token 的 git client（clone 后 `git diff` /
  `merge`）实现，mock 已用本地 git 验证逻辑。
- 任务状态持久化：Worker 内默认内存版；生产请实现 KV/D1 版 `TaskStore`
  （接口已定义，`src/store.ts`）。
- `triggers.events` 的 filter 键名以 `wrangler >= 4.118` 的部署校验为准
  （research/artifacts-brief.md 有官方文档链接）。

## 比赛提交物对照

- 演示视频（5–10 分钟）：录 `npm run dev` 的完整擂台流程
- 开源代码：本仓库（MIT）
- 运行说明：本 README
