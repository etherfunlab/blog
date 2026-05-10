---
title: eros-engine 记忆机制升级 — 给画像装上分类抽屉
description: 昨天那篇文章里的 schema 写了一列 `category` 但代码里其实没人填它。这篇是 PR #5–#8 把它补齐之后的工程笔记 — dreaming-lite 后台流水线怎么扫 idle session、用 Haiku 4.5 抽取分类、以多实例安全的方式落到 profile 层；以及下一步的时间衰减 × 重要性打分会怎么改。
date: 2026-05-11
tags: [eros-engine, memory, rust, dreaming, postgres, ai-companion]
draft: false
lang: zh
---

[上一篇](/zh/posts/2026-05-10-pgvector-voyage-companion-memory/) 的 schema 里写了一列 `category TEXT`。这列在 production migration（`0006_memory_category.sql`）里确实存在，但坦白讲：写入路径根本没人填它 — 整张表 `category` 全是 NULL，retrieval 也没在读。文末那段「我们用一段 Sonnet 4.6 的小 prompt，每 turn 产出 0-3 条候选记忆」描述同样是 *forward-looking* 的设计意图，不是当时跑的代码。也就是说昨天发文时候的 production engine 真实形态是：每轮聊天结束后把「用户那半句」原文塞进 profile 层，作为该用户的「画像」。这显然不是画像 — 是 raw turn dump。

PR #5–#8 把这两个空头承诺一起补完了。这篇是工程续集：实装了什么、为什么需要一个后台 dreaming 流水线，以及下一步打算怎么打磨。

## 昨天的实际状态：profile 层不是画像

先把「画像（profile memory）」和「关系记忆（relationship memory）」分清楚。前者是「这个用户是谁」— 跨 persona instance 通用；后者是「她和这个 persona 之间发生过什么」— 一对一连续性。两层都用 cosine 召回，落到 system prompt 的不同段落。

升级前的 profile 写入是这么走的：每轮聊天结束，post-process fan-out 把 `用户：xxx` 这半句直接 INSERT 进 `engine.companion_memories`，`category = NULL`。检索时按 cosine 距离 top-K，拼成 bullet list 注入 prompt 的「【你对他的了解】」一节。

这套跑得起来，但有几个问题：

1. **没有抽取**。「我今天加班到十点」是 raw 句子，不是事实；真正想长期记的是「她最近工作压力大」。模型每轮都看到一堆 raw 句子，得自己脑补结构。
2. **没有分类**。「住在上海」「喜欢爵士」「上周分手」「她妈叫她结婚」这四类信息的语义权重完全不同，但都按同一个 cosine 排序进同一个 bullet list。LLM 在写「关心一下她的工作」时召回到的可能是「住在上海」。
3. **schema 有结构但没用上**。`category` 列加进了 schema，但写入路径没在填、retrieval 也没在读；昨天文末那段 extraction prompt 同样属于 *将来* 的设计意图，不是当时跑的代码。

## PR #5–#8

四个 PR 把这条线补完：

- **PR #5** — 把已经在 schema 里的 `category` 接通到 Rust 侧：`MemoryRepo::upsert/search/MemoryRow` 全链路加上 `Option<&str>` 参数。Writer 先一律传 `None`（raw turn writer 没分类信息可填），先把接口形状定下来，让 PR #6 的分类器接上来时不需要 backfill。
- **PR #6** — 新增 `pipeline::dreaming` 模块（含 7 个单元测试）。tokio 后台 sweeper：扫 idle session（30 min 静默后），LLM 抽取 + 分类，写回 profile 层。
- **PR #7** — 检索端按 category 分组渲染。一条 `ROW_NUMBER() OVER (PARTITION BY category)` SQL 把 5 类各取 top-2，prompt 里改成多个带 `[标签]` 的子段，比如 `[客观事实]` / `[偏好]` / `[最近发生]` / `[情绪倾向]` / `[人际关系]`。
- **PR #8** — sweeper picker 改成 `UPDATE ... WHERE id IN (SELECT FOR UPDATE SKIP LOCKED) RETURNING ...`，多实例并发安全 + 崩溃自愈（`claim_stale` 阈值后被别的 worker 重抢）。

合起来叫 **dreaming-lite**：之所以叫 lite，是因为它只做 *抽取 + 分类*，不做跨 session 合并、去重、泛化（那是「真 dreaming」的范畴，下面会展开）。

## 为什么需要 dreaming（哪怕是 lite 的）

最直接的回答：你不能让 raw 句子直接当画像用。但更深层的问题是 *什么时候做抽取*。

最朴素的方案是 per-turn extraction — 用户每说一句，立刻调一次 LLM 抽事实写库。这个方案我们没选，原因有三：

1. **成本结构破坏**。前一篇说「memory 是 rounding error」 — embedding 每条 $0.000004，可以忽略。如果每轮多一次 Haiku 4.5 调用（哪怕便宜），就回到「memory 也开始烧钱」的世界。session-end 触发可以把 N 轮压成一次 LLM 调用。
2. **抽取需要上下文**。「我今天加班到十点」单独看是 event；但如果上一轮她说「我老板又压新需求」，那真正值得长期记的是「她最近工作压力大 + 老板压力源」。per-turn 看不到完整 session，抽出来的事实碎且重复。
3. **跟未来「真 dreaming」天然合并**。我们最终想做的是离线一次扫整 session、抽事实、合并相似记忆、泛化（这就是 *dreaming* 的命名来源 — 让 agent 像人一样「睡一觉把今天的事整理一下」）。session-end + 后台 sweeper 已经是这个形状的雏形，未来加 consolidation 一步是同一个 pass。

具体触发条件：30 分钟静默判断 session 结束，每 5 分钟扫一次未分类的 session。Haiku 4.5（不是 Sonnet 4.6 — 抽取分类是结构化「规整任务」，目前没有足够收益证明值得用 Sonnet）。每 session 输出 0-10 条 `{content, category}` 候选，逐条 Voyage embed 后写 profile 层。

5 类固定词表：`fact` / `preference` / `event` / `emotion` / `relation`。LLM 偶尔会发明新类别，`normalise_category` 把未知值塌陷成 `fact`，避免高基数把分组渲染撑爆。

## 多实例安全那一刀

dreaming-lite 是后台 sweeper，意味着 server 有多个 replica 时同一批 idle session 会被多个 worker 同时看到。最早的 picker 是 `SELECT ... ORDER BY ... LIMIT 10` 然后再 `UPDATE`，跨语句 race — 两个 worker 同时挑到同一条，跑两次 LLM 调用，写两遍重复记忆。

PR #8 改成单条 SQL：

```sql
UPDATE engine.chat_sessions
SET classification_claimed_at = now()
WHERE id IN (
    SELECT id FROM engine.chat_sessions
    WHERE classified_at IS NULL
      AND last_active_at < $1
      AND (classification_claimed_at IS NULL
           OR classification_claimed_at < $2)
    ORDER BY last_active_at
    LIMIT $3
    FOR UPDATE SKIP LOCKED
)
RETURNING id, user_id, instance_id
```

其中 `$1` 是 `now() - idle_threshold`，`$2` 是 `now() - claim_stale_threshold`，由 Rust 端预先算好绑定。

`FOR UPDATE SKIP LOCKED` 是 Postgres 的并发原语：被锁的行直接跳过，不阻塞、不报错。多个 worker 同时跑这条 SQL 各自拿到不重叠的 session 子集。`classification_claimed_at` 跟 `classified_at` 是两个独立列：claimed = 在跑、classified = 跑完。某个 worker 崩了，10 分钟（`claim_stale` 阈值）后这条 session 又会被别的 worker 重抢。

值得提一个细节：哪怕 LLM 抽出 0 条候选 / parse 失败，也要 stamp `classified_at = now()`。否则 poison-pill session 会无限循环占 sweeper 配额。只有网络错误才不 stamp，让它自然 retry。

## 成本算账

dreaming-lite 上线后，单用户月成本估算：

- 50 turn / 天，假设每 session 10 turns → ~150 sessions / 月
- 每 session 一次 Haiku 4.5（输入约 1500 token，输出约 200 token）≈ $0.002，外加 N 次 Voyage embed（按候选数，每次 ~$0.000002）— embedding 部分在金额上仍可忽略
- 150 × $0.002 ≈ **$0.30 / 用户 / 月**（dreaming）
- 加上 chat 路径上原本的 embedding $0.006 / 用户 / 月

跟前一篇的 embedding 数字差两个量级，但跟 chat LLM 调用本身（每用户 / 月通常 $5-10 量级）相比仍然是小头。可以接受。

## 下一步：时间衰减 + 重要性打分

dreaming-lite 解了「画像没结构」的问题，但召回排序仍然只有 cosine 距离一个维度。两个明显能继续打磨的方向：

**时间衰减（recency decay）**。当前同一 category 内按 cosine 距离排序，K=2 / category 取 top。问题是「她去年说住在上海」和「她上周说搬到东京了」两条事实并存时，cosine 不会偏向新的那条 — 取决于 query embedding 跟谁更近。打算把排序换成 similarity（即 `1 - <=>` cosine 距离，越大越好），再加一项时间项：`score = sim + λ · exp(-age / τ)`，τ 取几周量级；让旧事实自然衰减，但不硬删（万一下次召回真需要历史背景）。

**重要性打分（importance scoring）**。现在 5 类的 quota 是固定的 2 / category，但「她妈叫她结婚」（relation）和「她喜欢摩卡」（preference）显然不该等权。打算让 dreaming 抽取时同时输出 `importance: 0-1`，retrieval 时按 `sim × decay × importance` 复合排序（同样以 similarity 为基准），跨 category 抢全局 top-K 而不是固定配额。这条需要真流量调参 — 没有用户反馈数据之前调出来的权重都是猜的。

更远一点是「真 dreaming」：周期性扫同 user 同 category cosine 相似度高的 rows，LLM 合并去重。现在多 session 跑下来 `category=fact` 下会重复 5 条「住在上海」是预期问题；触发条件是用户反馈「记忆越来越乱」或者 prompt 里重复事实占比超过阈值。

具体会先动哪一个，看 eros-chat 上线后的真实流量信号。在那之前 engine 这边暂停打磨，把焦点切到前端。

## 试一下

代码仍然在 [`github.com/etherfunlab/eros-engine`](https://github.com/etherfunlab/eros-engine)（AGPL-3.0-only）：

- dreaming 模块：`crates/eros-engine-server/src/pipeline/dreaming.rs`
- Migration：`0006_memory_category.sql` / `0007_session_classified_at.sql` / `0008_session_classification_claim.sql`
- 分组检索：`MemoryRepo::search_profile_grouped` in `crates/eros-engine-store/src/memory.rs`
- Sweeper 配置：`DREAMING_TICK_SECS` / `DREAMING_IDLE_SECS` / `DREAMING_CLAIM_STALE_SECS`（`state.rs`）
- 关闭：`DREAMING_DISABLED=1`

跑起来需要 OpenRouter key（chat + dreaming 共用）和 Voyage key。本地验证 sweeper 行为可以把 `DREAMING_TICK_SECS=10 DREAMING_IDLE_SECS=30` 跑两轮聊天 + 30 秒静默，去 `engine.companion_memories` 看 `category` 列有没有真值。

---

*由 Henry Lin 提示，Opus 4.7 撰写。具体数字基于 `eros-engine` HEAD 截至 2026-05-10 的 PR #5–#8 验证。*
