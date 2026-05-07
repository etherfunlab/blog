---
title: 为什么 AI 伴侣产品不需要通用记忆层
description: 我们在 eros-engine 里从 Mem0 迁移到 pgvector + Voyage。这篇复盘解释：AI 伴侣需要的不是通用 facts store，而是围绕 persona 关系建模的记忆系统。
date: 2026-05-08
tags: [eros-engine, memory, rust, pgvector, ai-companion]
draft: false
lang: zh
---

> *Prompted by Henry Lin, written by Opus 4.7 and revised by GPT-5.5*

[`eros-engine`](https://github.com/etherfunlab/eros-engine) 第一版使用 Mem0 做长期记忆。后来我们把这层依赖移除，改成 Postgres + pgvector + Voyage embedding，并把记忆写入、检索和 post-process pipeline 收进自己的 Rust workspace。

这不是一次单纯的 vendor replacement。迁移以后更清楚的一点是：AI 伴侣产品需要的记忆抽象，和通用 agent memory layer 并不相同。

## 通用记忆层解决什么问题

Mem0、Letta、Zep 这类通用记忆层的典型抽象是：

```txt
user_id / agent_id / app_id / run_id -> extracted facts -> semantic retrieval
```

它们很适合客服 bot、RAG agent、文档助手和 workflow automation。系统从对话里抽取偏好、限制条件、任务上下文，再在下一轮任务里检索回来。对这类场景来说，记住“用户对花生过敏”或“这个客户使用 Enterprise plan”已经足够有价值。

AI 伴侣的核心目标不同。用户感受到“她记得我”的时刻，经常不是某条孤立事实命中，而是一个带有情绪和关系位置的片段被再次呼应：

- 上次争执发生在什么语境里。
- 用户为什么在某个夜晚突然沉默。
- 某个玩笑只在这段关系里成立。
- 某个称呼从陌生、试探，逐渐变成默认。

这些内容不是简单的 `facts`。它们更接近 relationship state 和 episodic memory：带 session、persona、情绪曲线、亲密度变化，以及“这段关系已经走到哪里”的上下文。

## 伴侣记忆需要两层语义

在 `eros-engine` 里，长期记忆被拆成两层：

| 层级 | Scope | 用途 |
|---|---|---|
| Profile memory | `user_id` | 跨 session、跨 persona 共享的用户画像，例如偏好、身份信息、长期约束。 |
| Relationship memory | `user_id + persona instance` | 当前用户和当前 persona 之间的关系记忆，例如共同经历、对话梗、冲突和修复。 |

这两个 scope 在通用记忆系统里也可以用 entity filter 模拟，但语义并不等价。Profile memory 主要服务于用户画像和后续推荐；relationship memory 主要服务于当前 persona 的连续性。它们的写入时机、检索数量、prompt 注入位置、失效策略都不同。

这也是我们最终没有把记忆层做成单独 SaaS 的原因：对伴侣产品来说，memory retrieval 不是一个独立 API 能完整表达的功能，而是 chat pipeline 里的一步。它要和 prompt assembly、affinity update、ghost decision、insight extraction 一起工作。

## 为什么移除 Mem0

迁移不是因为 Mem0 不能用，而是因为它解决的是更通用的问题。放进伴侣引擎以后，几个工程约束变得明显。

**延迟路径不可控。** 每轮聊天本来就有主 LLM 调用，再把 memory search 放到外部 cloud，会在同步路径上增加额外 RTT。迁移后，记忆检索变成同一个 Postgres 里的 pgvector 查询，生产路径更容易做 p95 / p99 优化。我们内部测试里，原先约 200ms 级别的外部 search RTT，降到本地 DB 约 5ms 级别。

**调试边界不清晰。** 通用记忆层会负责抽取、去重、合并和检索，产品早期迭代很方便；但当线上出现“这条记忆为什么消失了”“为什么新事实没有合并进去”时，黑箱程度会影响排障速度。pgvector 版本里，记忆就是 `engine.companion_memories` 的行，合并阈值、category、source message、soft delete 都是我们自己的 schema 和 SQL。

**Rust 集成成本不低。** Mem0 是 Python-first 生态。我们当时在 `eros-gateway` 里维护过一个 REST wrapper，schema 漂移时 deserializer 会直接成为故障点。迁移到 Postgres 后，`sqlx::query_as!` 能在编译期检查 SQL shape，Rust 侧边界更稳定。

**开源用户不应该被迫绑定第三方 SaaS。** `eros-engine` 的目标是自托管 AI 伴侣引擎。把核心记忆层绑定到托管 SaaS，会让自托管者天然多一个账号、账单和数据边界。pgvector 方案只依赖 Postgres 扩展和 embedding provider，更符合我们希望提供的 deployment model。

价格也因此需要谨慎表述。截至 2026-05-08 核查，Mem0 官方 pricing 是 Free / $19 Starter / $249 Pro，而不是早期材料里写过的 `$99/month` 起步。Voyage 官方 pricing 里，`voyage-3-lite` 属于 older text embedding model，价格为 `$0.02 / 1M tokens`，输出维度为 512。后续文章里的成本数字都应该按 token 量估算，而不是写成 per-call 固定价格。

## pgvector 版本怎么实现

核心表可以简化成这样：

```sql
CREATE TABLE engine.companion_memories (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL,
  instance_id uuid,        -- NULL = profile memory; non-NULL = relationship memory
  content     text NOT NULL,
  embedding   vector(512), -- voyage-3-lite
  category    text,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX ON engine.companion_memories
  USING ivfflat (embedding vector_cosine_ops);
```

`instance_id IS NULL` 表示 profile layer；`instance_id = <persona_instance_id>` 表示 relationship layer。同一张表承载两种语义，查询时通过 predicate 区分，不需要维护两套 schema。

写入放在 post-process 阶段。Chat 主流程先完成 LLM reply 并返回给前端，再用后台任务做 memory extraction、embedding 和 insert。这样记忆写入失败不会阻塞用户拿到回复，也不会把 embedding provider 的抖动放进聊天响应时间里。

检索则发生在 prompt assembly 前。系统对当前 user message 做一次 embedding，然后并行查询两层记忆：profile layer 取少量长期画像，relationship layer 取当前 persona 相关片段。检索结果再按不同 section 注入 system prompt，而不是混成一组“相关事实”。

这个实现的关键不是代码量，而是边界：

| 维度 | 通用 memory SaaS | `eros-engine` 内置 memory |
|---|---|---|
| 数据模型 | 通用 entity scope | profile / relationship 两层产品语义 |
| 检索位置 | 外部 API 调用 | chat pipeline 内部步骤 |
| 调试方式 | SDK / dashboard | SQL / trace / app log |
| 成本模型 | 托管服务价格 | Postgres + embedding tokens |
| 可扩展点 | provider feature | Rust code + schema migration |

## 为什么不做“开源 Mem0”

做完 pgvector 迁移以后，一个自然想法是把它包装成独立 memory service：加 `/memory/search`、`/insight`、multi-tenant namespace、quota、API key，再对外宣传为 Rust 版 Mem0。

我们没有这么做。

原因很简单：这会把产品的核心复杂度放错地方。AI 伴侣里的记忆不是用户主动调用的功能，也不是孤立的 developer API；它是关系状态机的一部分。它会影响 persona 怎么说话、是否回复、是否需要短暂冷处理、礼物反应怎么落到 affinity 上，以及下一轮 prompt 应该带哪些上下文。

如果把 memory 从 pipeline 里切成 SaaS，我们要花大量工程成本处理 tenant、quota、namespace、billing 和 public API compatibility；真正做伴侣、coaching、journaling、language tutor 的开发者，反而更需要一套可以直接嵌进自己 pipeline 的 crate 和 schema。

所以 `eros-engine` 的定位是 AI companion engine，不是通用 memory layer。记忆系统是引擎能力的一部分，和 affinity、PDE、post-process fan-out 共同组成产品体验。

## 当前架构位置

`eros-engine` 是一个 4-crate Rust workspace：

| Crate | 职责 |
|---|---|
| `eros-engine-core` | 纯逻辑：6 维 affinity vector、ghost decision、PDE 等。 |
| `eros-engine-llm` | OpenRouter chat client、Voyage embedding client、per-task model config。 |
| `eros-engine-store` | Postgres + pgvector 持久层，表放在 `engine` schema。 |
| `eros-engine-server` | Axum HTTP server、Supabase JWT middleware、pipeline orchestration。 |

记忆层主要在 `crates/eros-engine-store/src/memory.rs`，由 server pipeline 的 post-process 阶段调用。`affinity / memory / insight` 这类写入被放在回复之后并行执行，主聊天路径只保留必要的读取和 LLM 生成。

这让 memory layer 变成一个可观察、可迁移、可裁剪的内部模块，而不是一个必须单独部署和运营的服务。

## 适用边界

这套设计适合“同一个 persona 和同一个用户长期互动”的产品：

- AI companion / AI character chat
- journaling companion
- coaching agent
- language tutor
- vtuber interactive chat

它不一定适合通用 agent 产品。如果你的系统目标是完成任务，例如 customer support、enterprise RAG、文档问答、工作流自动化，Mem0 / Letta / Zep 这类通用 memory layer 仍然是更直接的抽象。

判断标准是：记忆主要是为了让 agent **更准确地完成任务**，还是为了让 persona **和用户形成连续关系**。前者适合通用 memory layer；后者应该把 memory 当成 companion engine 的内部状态，而不是外挂数据库。

---

代码在 [`github.com/etherfunlab/eros-engine`](https://github.com/etherfunlab/eros-engine)。`eros-engine` 当前按 AGPL-3.0-only 发布，自托管需要 Postgres + pgvector、OpenRouter 和 Voyage API key。后续会继续拆 6 维 affinity EMA、ghost streak 保护规则和 PDE 决策层。
