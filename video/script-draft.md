# Merge Arena 演示视频脚本（draft v1）

> 目标时长：约 8:45（5–10 分钟要求内）。英文旁白（评委为 Cloudflare 国际团队）+ 英文字幕，
> 每段附中文对照。全部画面为本地 UI 录屏（`npm run dev` → http://localhost:8787），无真人出镜。
> 诚实边界：演示跑在本地 mock（git 裸仓 + ScriptedAgent）上；打分是确定性 stub；
> 真实 Artifacts 走同一接口（见"原理"段）。不要在旁白里宣称已部署真实 Artifacts、
> LLM 裁判或自动跑测试——这些是下一步。

## 制作说明

- 录屏：1920×1080，Chrome 无痕窗口，只录浏览器内容区
- 提前完整走一遍流程（lanes 每 2 秒轮询，全程真实耗时约 1–2 分钟；剪辑时可 1.5× 加速实况段）
- 旁白：英文（TTS 或人声均可），配英文字幕；背景音乐可选、音量压低
- 关键点击处加鼠标高亮/圆圈标注；排行榜揭晓处可加短暂停顿 + 音效

---

## 一、旁白脚本

### Act 1 — Hook（0:00–0:45）痛点

**EN:**
"Here's a problem GitHub never had to solve. When humans write code, pull requests work fine — one branch, one review, one merge. But agents don't work like humans. They work in parallel. Ten agents, a hundred agents, all editing the same codebase at the same time. Who changed what? Which solution is actually better? And whose code ships? Serial pull requests collapse under that load. So we stopped asking how agents fit into pull requests — and asked what review looks like when it's built for agents from the ground up. This is Merge Arena."

**中文：**
"这是 GitHub 从未需要解决的问题。人类写代码时，pull request 够用了——一个分支、一次评审、一次合并。但 agent 不是人类，它们并行工作。十个、一百个 agent 同时改同一个代码库。谁改了什么？哪个方案更好？最后合谁的？串行的 PR 在这种负载下会崩掉。所以我们不再问 agent 如何适应 PR，而是问：为 agent 从零设计的评审长什么样？这就是合并擂台 Merge Arena。"

### Act 2 — 演示（0:45–6:00）完整跑一遍

#### 2a. 开赛（0:45–1:30）

**EN:**
"Let me show you. Our baseline is a real project — NewsNow, a news aggregator running on Cloudflare. The task: add a dark mode toggle. One task, three agents. I hit 'start the match' — and behind the scenes, Merge Arena forks the baseline repository three times using Cloudflare Artifacts, one isolated workspace per agent. Each agent gets its own short-lived write token — least privilege, expiring in an hour. No shared branches, no stepping on each other. Three agents, three arenas. And they're off."

**中文：**
"看演示。基线是一个真实项目——NewsNow，跑在 Cloudflare 上的新闻聚合站。任务：给新闻站加一个深色模式开关。一个任务，三个 agent。点击'开赛'——幕后，Merge Arena 用 Cloudflare Artifacts 把基线仓库 fork 出三个隔离工作区，每个 agent 一个。每个 agent 拿到自己的短期写 token——最小权限，一小时过期。没有共享分支，互不干扰。三个 agent，三个擂台。开赛。"

#### 2b. 擂台实况（1:30–3:00）三条 lane

**EN:**
"Now watch them race. Each lane is an agent's live status: coding, pushed, scored. Each one cloned its own fork, made its changes, and pushed back to its own main branch. The moment a push lands, Artifacts fires a repo-pushed event, and our review pipeline picks it up automatically — no human in the loop. You can literally watch three different solutions to the same task take shape at the same time. A pull request list will never show you this.
Quick honesty note: for this demo, three scripted personas stand in for real coding agents — thorough, plain, and sloppy. In production, you plug in any agent through the AgentRunner interface: we hand it the workspace remote and token, it clones, works, and pushes."

**中文：**
"看它们开赛。每条 lane 是一个 agent 的实时状态：编码中、已推送、已评分。每个都 clone 了自己的 fork、改完代码、push 回自己的 main 分支。push 落地的瞬间，Artifacts 触发 repo-pushed 事件，评审流水线自动接管——全程无需人工。你能亲眼看到同一任务的三个不同解法同时成型，PR 列表永远给不了你这个视角。
诚实说明一下：演示里是三个脚本化 persona（细致 / 普通 / 马虎）代替真实 coding agent；生产环境通过 AgentRunner 接口接入任意 agent——我们把工作区的 remote 和 token 交给它，它 clone、干活、push。"

#### 2c. 排行榜揭晓（3:00–4:00）

**EN:**
"And here's the leaderboard. Scoring is deterministic and fully explainable — no black box. Points for the size of the change, capped so nobody wins by spamming lines. A fifty-point bonus for adding tests. Twenty points for shipping without TODOs. Watch: the thorough agent added a smoke test, so it takes the lead. The sloppy one left a TODO in its notes — and the scoreboard punishes it. Every point traces back to the diff. In production, you can swap this stub for an LLM judge or real test runs — the pipeline doesn't care, it just consumes scores."

**中文：**
"排行榜揭晓。打分是确定性的、完全可解释的——没有黑盒。按改动规模给分（封顶，刷行数没用）；补测试加 50 分；无 TODO 加 20 分。看：细致的 agent 补了个冒烟测试，直接登顶；马虎的那个在记录里留了 TODO——记分牌扣它分。每一分都能追溯到 diff。生产环境可以把这个 stub 换成 LLM 裁判或真实跑测试——流水线只管消费分数，不在乎谁打的。"

#### 2d. 并排 diff 对比（4:00–5:15）

**EN:**
"But scores aren't the whole story — so let's look at the code. Pick any agent, pick any file, and you get a side-by-side diff against the baseline main: green for additions, red for deletions, line-aligned. This is the moment serial review can't give you: three complete, competing implementations of the same feature, comparable on one screen. You're not reviewing one pull request and wondering what the alternative would have looked like. You're looking at all the alternatives."

**中文：**
"但分数不是全部——看代码。任选一个 agent、任选一个文件，就能看到它与基线 main 的并排 diff：绿色新增、红色删除，逐行对齐。这是串行评审永远给不了的时刻：同一功能的三个完整竞品实现，在一屏之内直接对比。你不再是对着一个 PR 猜'另一种写法会是什么样'——所有备选方案都在你眼前。"

#### 2e. 合并冠军（5:15–6:00）

**EN:**
"Decision time. One click merges the champion into the baseline main. The other attempts aren't deleted — they stay in history with their scores and diffs, so you always know why this one won. That's the whole loop: one task in, three solutions out, one winner merged. Fork to merged champion — in this video, under six minutes; in real life, however long your agents take."

**中文：**
"决胜时刻。一键把冠军合并进基线 main。落选的方案不会被删除——它们带着分数和 diff 留在历史里，你永远知道为什么是它赢。完整闭环：一个任务进，三个方案出，一个冠军合并。从 fork 到合并冠军——视频里不到六分钟；真实世界里，取决于你的 agent 有多快。"

### Act 3 — 原理（6:00–8:00）架构一句话

**EN:**
"So how does it work? Three primitives from Cloudflare Artifacts, composed into one loop.
One: fork. A single API call clones the baseline into an isolated workspace per agent — Artifacts speaks Git, so agents use the tools they already know.
Two: scoped tokens. Each workspace mints a short-lived write token — least privilege, expiring. Agents can push to their own fork, and nothing else.
Three: events. Every push fires a repo-pushed event. A queue consumer catches it, scores the diff, and updates the leaderboard — fully automatic.
The whole architecture in one line: forked workspaces, token-scoped agents, event-driven review.
And the part I'm proud of: every line of business logic runs against a single storage interface. What you just watched ran on local git repos — the production build talks to real Artifacts through the Workers binding with zero changes. npm run dev here, wrangler deploy there."

**中文：**
"原理是什么？Cloudflare Artifacts 的三个原语，组成一个闭环。
一，fork：一次 API 调用，把基线克隆成每个 agent 的隔离工作区——Artifacts 讲 Git，agent 用本来就会的工具。
二， scoped token：每个工作区签发短期写 token——最小权限、自动过期。agent 只能 push 自己的 fork，别的什么都动不了。
三，事件：每次 push 触发 repo-pushed 事件，队列消费者接住它、打分、更新排行榜——全自动。
整个架构一句话：fork 出工作区、token 圈定权限、事件驱动评审。
最得意的一点：所有业务逻辑只依赖一个存储接口。你刚才看到的跑在本地 git 仓库上；生产构建走 Workers binding 接真实 Artifacts，零改动。这边 npm run dev，那边 wrangler deploy。"

### Act 4 — 收尾（8:00–9:00）为什么这是下一代

**EN:**
"Pull requests were designed for humans reviewing in series. Agents work in parallel — so review should too. Merge Arena turns review into a tournament: agents compete, you compare, the best code wins. That's what the next Git platform looks like — not GitHub with agents bolted on, but collaboration rethought for the agentic era, built on Workers and Artifacts.
Next up: LLM judges, real test suites per contender, and one-click preview deploys for every finalist. The code is MIT-licensed — link below. Clone it, run npm run dev, and start your own arena. May the best agent win."

**中文：**
"Pull request 是为串行评审的人类设计的。Agent 并行工作——评审也该并行。Merge Arena 把评审变成擂台赛：agent 竞技、你来对比、最好的代码获胜。这就是下一代 Git 平台的样子——不是给 GitHub 外挂 agent，而是为 agent 时代重想协作，建在 Workers 和 Artifacts 之上。
下一步：LLM 裁判、每个候选者跑真实测试套件、一键 preview 部署。代码 MIT 开源，链接在下方。clone 下来，npm run dev，开你自己的擂台。愿最强的 agent 获胜。"

---

## 二、分镜表

| 时间 | 旁白要点 | 画面（录屏） | 停留/处理 | 标注与字幕 |
|---|---|---|---|---|
| 0:00–0:15 | GitHub 从未解决的问题 | 黑屏 → 打字机字幕："10 agents. 100 agents. One codebase." | 纯字幕卡 15s | 英文字幕，无 UI |
| 0:15–0:45 | PR 串行 vs agent 并行 | 快速闪切：GitHub PR 列表页（公开页面）→ 切回 Arena 首页 | 闪切 3–4 个镜头 | 标注："Serial PRs" → "Parallel agents" |
| 0:45–1:30 | 开赛：输入任务、3 agent、点开赛 | "新开擂台"卡片：输入"给新闻站加一个深色模式开关"，基线 newsnow-baseline，选 3 个 agent，点击"开赛"（鼠标高亮） | 正常速度，输入过程可 1.5× | 字幕同步；按钮处画圈 |
| 1:30–2:10 | 三条 lane 实况 | "擂台实况"三条 lane：agent-0/1/2 状态"编码中"蓝色 badge | 停留 15–20s，可加速 | 标注每条 lane 的 persona（thorough/plain/sloppy） |
| 2:10–3:00 | push → 事件 → 评分自动 | lane 状态逐个翻转：编码中 → 已推送（黄）→ 已评分（绿）+ 分数出现 | 剪辑加速到 30–40s | 画面角落小字："push → cf.artifacts.repo.pushed → auto review" |
| 3:00–4:00 | 排行榜揭晓 | "排行榜"表格：冠军行高亮（橙色），列：总分/改动行数/有测试✅/无TODO | 停留 25–30s，逐行扫过 | 标注："deterministic scoring"；给 ✅/— 列特写 3s |
| 4:00–4:40 | 选 agent、选文件 | "代码对比"：点 agent-0 tab，再点 ARENA-NOTES.md / README.md / test/arena.test.ts 文件 tab | 正常速度 | 标注："any agent × any file" |
| 4:40–5:15 | 并排 diff | 双栏 diff：左"基线 main"右"该 agent"，绿/红行高亮，缓慢滚动 | 停留 20s，慢滚 | 标注："side-by-side vs baseline main" |
| 5:15–6:00 | 一键合并冠军 | 点"合并冠军" → 浏览器 confirm 对话框（点确定）→ "合并成功：agent-0 → <commit>" | 正常速度，对话框停留 3s | 字幕："one click. champion merged." |
| 6:00–7:00 | fork / token / 事件三原语 | 架构简图（静态图或 Keynote 一页）：Task → fork×3 → token → push → event → score → merge | 静态图 45–60s，配合旁白逐项高亮 | 图上三处标注：fork / scoped token / repo.pushed |
| 7:00–8:00 | 同一接口：本地 mock vs 真实 binding | 左右分屏：左 `src/store.ts` 接口代码，右 `artifacts-mock.ts` vs binding 切换示意（2–3 行关键代码） | 停留 30s | 标注："same interface. npm run dev ↔ wrangler deploy" |
| 8:00–8:40 | PR→擂台：下一代 Git 平台 | 回到 Arena 首页全景，缓慢推近到排行榜冠军行 | 慢推 20s | 大字幕："Review, rethought for the agentic era" |
| 8:40–9:00 | CTA：MIT 开源、开你自己的擂台 | 结束卡：Merge Arena logo/标题 + "MIT Licensed · link below" + "May the best agent win." | 结束卡 20s | 片尾放代码仓库链接 |

**剪辑备注：**
- 实况段（1:30–3:00）真实等待约 1–2 分钟，剪辑加速到 30–40 秒，保留状态翻转的"揭晓感"
- 全程英文字幕；技术词保持英文原词（Artifacts / Workers / fork / merge / token / push event）
- 不需要配音员出镜；旁白用 TTS 或人声录制后对轨

---

## 三、提交清单

比赛：Cloudflare「下一代 Git 平台」——用 Workers + Artifacts 为 agent 时代打造 Git 平台。
官方公告：https://blog.cloudflare.com/next-git-platform-on-cloudflare/

### 三件套

- [ ] **演示视频（5–10 分钟）**：本脚本目标约 8:45。录 `npm run dev` 完整擂台流程，按分镜表剪辑，英文旁白 + 英文字幕
- [ ] **开源代码链接（MIT/Apache/BSD）**：本仓库，LICENSE 已为 MIT（Copyright (c) 2026 suoyi2022）。提交前确认仓库已公开，链接有效
- [ ] **运行说明**：README.md —— 本地 `npm install && npm run dev` 打开 http://localhost:8787；真实 Artifacts 部署步骤（namespace 创建、binding 配置、基线导入）已在 README "切换到真实 Artifacts"一节

### 关键提醒

- ⏰ **截止 2026-10-14**：预留至少 1 天 buffer，目标 10-13 完成提交
- 💳 **前置：Workers Paid plan（$5/月）**：真实 Artifacts 环境必需；本地演示不需要
- 🆓 **Artifacts 计费 2026-10-15 起**：比赛窗口（截止 10-14）内 effectively 免费
- 📤 提交入口见官方公告页的 Submissions 链接；提交时确认三件套链接可公开访问
- 🤫 口径：所有台前材料（仓库、提交、视频）署名均为本人；不出现 AI 参与痕迹

### 提交前自查

- [ ] 视频时长 5–10 分钟之间
- [ ] 视频中演示的功能均为脚手架已验证链路（开赛→lanes→排行榜→diff→合并），无过度承诺
- [ ] 代码仓库公开，LICENSE 为 MIT
- [ ] README 运行说明按步骤可复现（找一台干净机器验证一遍 `npm install && npm run dev`）
- [ ] 提交表单三项链接逐一点击验证
