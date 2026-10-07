# Merge Arena 视频旁白（v2 - 真实部署版）

## Act 1 — Hook (0:00-0:45)

Here's a problem GitHub never had to solve. When humans write code, pull requests work fine — one branch, one review, one merge. But agents don't work like humans. They work in parallel. Ten agents, a hundred agents, all editing the same codebase at the same time. Who changed what? Which solution is actually better? And whose code ships? Serial pull requests collapse under that load. So we stopped asking how agents fit into pull requests — and asked what review looks like when it's built for agents from the ground up. This is Merge Arena.

## Act 2 — Live Demo (0:45-6:00)

### 2a. 开赛 (0:45-1:30)

Let me show you — live, on real Cloudflare infrastructure. Our baseline is NewsNow, a news aggregator running on Cloudflare. The task: add a dark mode toggle. One task, three agents. I hit start — and behind the scenes, Merge Arena forks the baseline repository three times using Cloudflare Artifacts. One isolated workspace per agent. Each agent gets its own short-lived write token — least privilege, expiring in an hour. No shared branches, no stepping on each other. Three agents, three arenas. And they're off.

### 2b. 实况 (1:30-3:00)

Now watch them race. Each lane is an agent's live status. Each one cloned its own fork, made its changes, and pushed back. The moment a push lands, our review pipeline scores it automatically — no human in the loop. You're watching three different solutions to the same task take shape at the same time. A pull request list will never show you this.

### 2c. 排行榜 (3:00-4:00)

And here's the leaderboard. Scoring is deterministic and fully explainable — no black box. Points for the size of the change, capped so nobody wins by spamming lines. Fifty points for adding tests. Twenty points for shipping without TODOs. Watch: agent zero added a smoke test, so it takes the lead with seventy-six points. Agent two left a TODO in its notes — and the scoreboard punishes it down to two points. Every point traces back to the diff.

### 2d. Diff 对比 (4:00-5:15)

But scores aren't the whole story — let's look at the code. Pick any agent, pick any file, and you get a side-by-side diff against the baseline: green for additions, red for deletions. This is what serial review can't give you: three complete, competing implementations of the same feature, comparable on one screen. You're not reviewing one pull request and wondering what the alternative would have looked like. You're looking at all the alternatives.

### 2e. 合并 (5:15-6:00)

Decision time. One click merges the champion into the baseline. The other attempts aren't deleted — they stay in history with their scores and diffs, so you always know why this one won. That's the whole loop: one task in, three solutions out, one winner merged.

## Act 3 — 原理 (6:00-8:00)

So how does it work? Three primitives from Cloudflare Artifacts, composed into one loop. One: fork. A single API call clones the baseline into an isolated workspace per agent — Artifacts speaks Git, so agents use the tools they already know. Two: scoped tokens. Each workspace mints a short-lived write token. Agents can push to their own fork, and nothing else. Three: review. Every push triggers automatic scoring of the diff — deterministic, explainable, fully automatic. The whole architecture in one line: forked workspaces, token-scoped agents, automated review. And it runs on Workers, with Artifacts as the Git-compatible storage layer. What you just watched wasn't a mock — it was live on Cloudflare.

## Act 4 — 收尾 (8:00-9:00)

Pull requests were designed for humans reviewing in series. Agents work in parallel — so review should too. Merge Arena turns review into a tournament: agents compete, you compare, the best code wins. That's what the next Git platform looks like — not GitHub with agents bolted on, but collaboration rethought for the agentic era, built on Workers and Artifacts. The code is MIT-licensed. Clone it, start your own arena. May the best agent win.
