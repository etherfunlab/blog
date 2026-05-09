---
title: pgvector + Voyage 做 AI 伴侣记忆 — 比 Mem0 省 5 倍 RAM
description: 我们怎么用 Postgres + pgvector + Voyage embedding 跑 AI 伴侣记忆层，以及为什么砍掉 Mem0 sidecar 之后引擎稳态内存掉到原来的 1/5。包含具体 schema、Rust 写入 / 检索 loop、以及在 shared-cpu-1x 自托管的部署算账。
date: 2026-05-10
tags: [eros-engine, memory, rust, pgvector, voyage, ai-companion, self-hosting]
draft: false
lang: zh
---

上一篇文章讨论了[为什么 AI 伴侣产品不需要通用记忆层](/zh/posts/2026-05-08-why-ai-companions-dont-need-generic-memory/)。这一篇是工程续集：替代方案到底是怎么搭起来的。

核心结果：从 `eros-engine` 中砍掉 Mem0 sidecar、把记忆收进 Postgres + pgvector + Voyage 之后，记忆相关组件的稳态 RAM 降到原来的约 1/5。听起来像营销话术，但它不是 benchmark headline — 它是「删掉一整个 Python 进程 + 它在内存里维护的索引」之后的自然结果。下面拆开看：删了什么，换成了什么，以及怎么自己复现。

代码在 [`github.com/etherfunlab/eros-engine`](https://github.com/etherfunlab/eros-engine)，AGPL-3.0-only。记忆层在 `crates/eros-engine-store/src/memory.rs`，调用它的 post-process fan-out 在 `crates/eros-engine-server/src/pipeline/post_process.rs`。

## Mem0 的 RAM 用在哪

哪怕规模不大，一个 Mem0 部署的运行件比 SDK 暗示的更多：

1. SDK / server 的 Python 进程：解释器本身、glibc 分配、import 进来的一长串模块。
2. 内存里的 ANN 索引。向量索引天生 RAM-hot — 想要低延迟检索，索引就得在内存里。
3. dedup、最近写入缓冲、embedding 结果缓存等等的 caches。
4. 如果 embedding 模型自托管（不是 OpenAI），还要算上模型权重本身。

切到 pgvector 之后，这四样全没了。Rust 进程发短 HTTP 请求给 Voyage，向 Postgres 发 INSERT 和 SELECT，完。Postgres 本来就在跑（我们用它存 `auth.users`、chat sessions、affinity state、persona genomes 等等），所以新增 `engine.companion_memories` 的边际 RAM 成本就是表本身和它的索引 — Postgres 自己按需 page in/out。

这就是 "5× less RAM" 背后的工程形态：我们没有优化什么，我们删掉了一个进程。

## 为什么是 Voyage

Voyage 不是唯一的 embedding API。我们选它是因为它跟引擎已有的几个约束对得上：

- **多语言质量。** Eros 聊天 session 经常跨 zh/en/ja/ko。Voyage `voyage-3-lite` 是英文之外不明显劣化里最便宜的一档。
- **价格。** `$0.02 / 1M input tokens`，每条消息的 embedding 成本相对 chat LLM 调用是个 rounding error。
- **OpenAI 兼容请求形态。** 以后若想跨 provider benchmark，几乎是 drop-in。
- **没有 OpenAI 依赖。** 项目硬规则：引擎全链路零 OpenAI；这就排除了 `text-embedding-3-*`。

输出维度 512（`voyage-3-lite` 默认）。在我们的规模下 512 的关系记忆召回质量已经足够；1024+ 只是把索引撑大、检索质量没有可测的提升。

## Schema

```sql
CREATE TABLE engine.companion_memories (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL,
  instance_id uuid,                 -- NULL = profile 层；非 NULL = relationship 层
  content     text NOT NULL,
  embedding   vector(512) NOT NULL, -- voyage-3-lite 输出
  category    text,                 -- 'fact' | 'preference' | 'event' | ...
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX companion_memories_user_idx
  ON engine.companion_memories (user_id);

CREATE INDEX companion_memories_user_persona_idx
  ON engine.companion_memories (user_id, instance_id);

CREATE INDEX companion_memories_embedding_idx
  ON engine.companion_memories
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

几个值得展开说的取舍：

- **两层共用一张表。** Profile 记忆 `instance_id IS NULL`；relationship 记忆 `instance_id = <persona_instance_id>`。语义切分放在查询里（`WHERE instance_id IS NULL` vs `WHERE instance_id = $1`），不开两张物理表。Migration 面更小，不重复维护索引。
- **`ivfflat` 而非 `hnsw`。** 在我们的行数下，`ivfflat lists = 100` 建索引快、ANALYZE 快、召回质量够。等行数大到 hnsw 的建索引代价不再敏感，再切。
- **`vector_cosine_ops`。** Voyage embedding 是单位归一化的，cosine 和 dot product 等价；cosine 是更常见的默认，SQL 也读起来更好。
- **没有 soft delete。** 删除记忆很少见且会被审计；真要删时直接物理删，由审计 log 留痕。

## 写入 — embedding 在 post-process 阶段

写入发生在聊天回复返回 *之后*。Chat handler 把用户消息 + persona 回复交给一个 Tokio task，立刻返回客户端。memory 写失败不会阻塞用户能看到的聊天体验。

```rust
// crates/eros-engine-store/src/memory.rs (paraphrased)
pub async fn write_memory(
    pool: &PgPool,
    voyage: &VoyageClient,
    user_id: Uuid,
    instance_id: Option<Uuid>,
    content: &str,
    category: &str,
) -> Result<(), MemoryError> {
    let embedding = voyage.embed(content).await?; // [f32; 512]

    sqlx::query!(
        r#"
        INSERT INTO engine.companion_memories
            (user_id, instance_id, content, embedding, category)
        VALUES ($1, $2, $3, $4, $5)
        "#,
        user_id,
        instance_id,
        content,
        // sqlx pgvector adapter 把 &[f32] → vector
        &embedding[..] as &[f32],
        category,
    )
    .execute(pool)
    .await?;

    Ok(())
}
```

生产代码额外加了：Voyage 短暂错误的重试、按用户的写入频率限制、以及单行长度上限（防止 extraction prompt 一旦失控写出 50KB 行）。

## 检索 — 双层并行查询

聊天 prompt 装配器在下一次 LLM 调用前并发跑两层查询。用户消息只 embed 一次，然后两个 `tokio::spawn` 同时跑。

```rust
let q_emb = voyage.embed(user_message).await?;

let (profile_hits, relationship_hits) = tokio::join!(
    sqlx::query_as!(
        MemoryRow,
        r#"
        SELECT id, content, category, created_at
        FROM engine.companion_memories
        WHERE user_id = $1 AND instance_id IS NULL
        ORDER BY embedding <=> $2
        LIMIT $3
        "#,
        user_id,
        &q_emb[..] as &[f32],
        profile_k,
    ).fetch_all(pool),
    sqlx::query_as!(
        MemoryRow,
        r#"
        SELECT id, content, category, created_at
        FROM engine.companion_memories
        WHERE user_id = $1 AND instance_id = $2
        ORDER BY embedding <=> $3
        LIMIT $4
        "#,
        user_id,
        persona_instance_id,
        &q_emb[..] as &[f32],
        relationship_k,
    ).fetch_all(pool),
);
```

`<=>` 是 pgvector 的 cosine 距离运算符。`profile_k` 通常较小（常用 3）；`relationship_k` 通常更大（常用 6-8），因为 relationship 记忆才是产生「她记得我」效应的那一层。两组结果分别落到 system prompt 的不同段落 — *不是* 合成一组「相关事实」。

## 自托管的算账

Eros 跑在 Fly.io shared-cpu-1x（256 MB RAM 上限，scale-to-zero）。Mem0 sidecar 退场后，引擎跑得很从容：

- Rust 进程稳态：几十 MB。
- Postgres 连接池在引擎侧的 overhead：几十 MB；数据库本身是另一个 Fly app。
- ~10k 条记忆 × 512 维的 pgvector 索引：数据库侧几 MB；定期 ANALYZE 让查询性能稳定。

对类似硬件上的自托管者来说，实操含义是：你不需要专门的 memory service。一个小 Rust 二进制 + 你已经在跑的 Postgres 就是部署。少了一个容器、一组凭证、一处账单可以攒、一个跨进程 latency 来源在聊天热路径上。

## 单用户成本

具体数字 — 一个聊天活跃的用户、约 50 turn/天、两层都有写有读：

- 每 turn：1 次 embedding 写（用户事实的 paraphrase）+ 1 次回复上下文用的 query embedding。共约 200 tokens，按 $0.02 / 1M 算 = `$0.000004 / turn`。
- 50 turn/天 × 30 天 = 1500 turn × $0.000004 ≈ **$0.006 / 用户 / 月** embedding。
- 存储：~3KB / 行 × ~30 新行 / 月 ≈ 可忽略。

Chat LLM 调用占成本大头。Memory 是 rounding error。

## 相对 Mem0 你失去了什么

诚实讲：

- **Extraction prompt 自己写。** Mem0 自带 extraction 逻辑；我们这套栈里，需要自己写「把用户刚说的话抽成值得记的 memory」的 prompt。我们用一段 Sonnet 4.6 的小 prompt，每 turn 产出 0-3 条候选记忆。
- **Dedup 自己做。** Mem0 内置基于相似度的 dedup。我们在 insert 前做一次便宜的 cosine 预查：如果新 embedding 与该用户最近 50 条记忆的最大 cosine 高于阈值，就跳过。
- **没有托管的 dashboard。** 没有现成的「列出某用户所有记忆」UI。我们开发期用 Supabase 的 table view，生产期挂一个最小的 `/admin/memories?user_id=...` endpoint 调试。

如果团队还没准备好接手这三块，Mem0 是更稳妥的选择。如果你已经在跑 Postgres、又已经在写 Rust（或任何 sqlx 友好的语言），这套更轻。

## 试一下

想看代码：

- 仓库：[`github.com/etherfunlab/eros-engine`](https://github.com/etherfunlab/eros-engine)（AGPL-3.0-only，4 crate Rust workspace）
- 记忆层：`crates/eros-engine-store/src/memory.rs`
- Post-process fan-out（写入触发点）：`crates/eros-engine-server/src/pipeline/post_process.rs`
- Migration：`crates/eros-engine-store/migrations/0003_memory.sql`

自托管需要 Postgres 15+ 装 `vector` extension、一把 OpenRouter key 给 chat、一把 Voyage key 给 embedding。README 里有完整 bring-up。欢迎 issue 和 PR — 特别是 extraction prompt 质量、ivfflat → hnsw 迁移 runbook 这类。

---

*由 Henry Lin 提示，Opus 4.7 撰写。具体数字基于 `eros-engine` HEAD 截至 2026-05-10 验证。*
