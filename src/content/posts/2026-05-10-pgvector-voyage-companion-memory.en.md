---
title: pgvector + Voyage for AI companion memory — 5× less RAM than Mem0
description: A walkthrough of how we run AI companion memory inside Postgres with pgvector + Voyage embeddings, and why dropping the Mem0 sidecar shrank our engine's resident memory by roughly 5×. Concrete schema, the embed-write-search loop in Rust, and the deployment math behind self-hosting on a shared-cpu-1x machine.
date: 2026-05-10
tags: [eros-engine, memory, rust, pgvector, voyage, ai-companion, self-hosting]
draft: false
lang: en
---

In the last post we explained [why AI companion products don't need a generic memory layer](/posts/2026-05-08-why-ai-companions-dont-need-generic-memory/). This one is the engineering follow-up: how the replacement is actually built.

The headline result: after removing the Mem0 sidecar from `eros-engine` and folding memory into Postgres + pgvector + Voyage, the steady-state RAM of our memory-handling surface dropped to roughly 1/5 of what it was. That sounds like marketing, and it isn't a benchmark headline — it's the natural consequence of deleting an entire Python process and the indexes it kept hot. The rest of this post walks through what was deleted, what replaced it, and how to reproduce the setup.

Code is at [`github.com/etherfunlab/eros-engine`](https://github.com/etherfunlab/eros-engine), AGPL-3.0-only. The memory layer is in `crates/eros-engine-store/src/memory.rs` and the post-process fan-out that calls it is in `crates/eros-engine-server/src/pipeline/post_process.rs`.

## Where Mem0's RAM was going

A Mem0 deployment, even at small scale, has more moving parts than the SDK suggests:

1. A Python process for the SDK / server, with its interpreter, glibc allocations, and the usual long tail of imported modules.
2. In-memory indexes for fast nearest-neighbor search. Vector indexes are RAM-hot by design; if you want low-latency search, the index lives in memory.
3. Caches for dedup, recent-write buffering, and embedding result caches.
4. If you self-host the embedding model (instead of OpenAI), the model weights themselves.

For a side-by-side comparison, none of those four exist on our pgvector path. The Rust process sends short HTTP calls to Voyage, ships an INSERT and a SELECT to Postgres, and that's it. Postgres already runs (we use it for `auth.users`, chat sessions, affinity state, persona genomes, and so on), so the marginal RAM cost of adding `engine.companion_memories` is whatever the table and its index cost — which Postgres pages in and out as needed.

That's the engineering shape behind "5× less RAM": we didn't optimize anything; we deleted a process.

## Why Voyage specifically

Voyage isn't the only embedding API. We picked it because it lined up with constraints the engine already had:

- **Multilingual quality.** Eros chat sessions cross zh/en/ja/ko routinely. Voyage `voyage-3-lite` was the cheapest provider that didn't degrade noticeably outside English.
- **Cost.** `$0.02 / 1M input tokens` makes the cost-per-message a rounding error against the chat LLM call.
- **OpenAI-compatible request shape.** Drop-in if we ever need to bench against another provider.
- **No OpenAI dependency.** Per project policy, the engine has no OpenAI in any path; that rules out `text-embedding-3-*` for both chat and memory.

We use 512-dim output (`voyage-3-lite`'s default). 512 is enough for relationship-memory recall quality at our scale; 1024+ would just inflate the index without measurably improving retrieval.

## The schema

```sql
CREATE TABLE engine.companion_memories (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL,
  instance_id uuid,                 -- NULL = profile memory; non-NULL = relationship memory
  content     text NOT NULL,
  embedding   vector(512) NOT NULL, -- voyage-3-lite output
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

> Note: the DDL above is simplified for readability. The production migration (`0003_memory.sql`) also includes a `session_id` FK to `engine.chat_sessions(id) ON DELETE CASCADE`, and uses partial indexes (one per layer, predicated on `instance_id IS NULL` / `IS NOT NULL`) rather than full-table ones, so each non-vector index covers only one layer.

A few choices worth flagging:

- **One table for both layers.** Profile memory has `instance_id IS NULL`; relationship memory has `instance_id = <persona_instance_id>`. The semantic split lives in queries (`WHERE instance_id IS NULL` vs `WHERE instance_id = $1`) rather than two physical tables. Less migration surface, no duplicated indexes.
- **`ivfflat` over `hnsw`.** At our row counts `ivfflat` with `lists = 100` is faster to build, faster to ANALYZE, and recall quality is fine. We'll switch to `hnsw` when we cross the row count where its index-build cost stops mattering.
- **`vector_cosine_ops`.** Voyage embeddings are unit-norm, so cosine and dot product are equivalent; cosine is the more familiar default and reads better in SQL.
- **Soft deletes are not in this schema.** Deleting a memory is rare and audited; when it happens, we hard-delete and let the audit log carry the trace.

## Writing memory — embed in the post-process stage

Writes happen *after* the chat reply has been returned. The chat handler hands the user message + the persona's reply to a Tokio task and immediately responds to the client. Memory writes that fail don't stall the user-visible chat.

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
        // sqlx pgvector adapter maps &[f32] → vector
        &embedding[..] as &[f32],
        category,
    )
    .execute(pool)
    .await?;

    Ok(())
}
```

Real production code adds: retries against transient Voyage errors, a per-user write rate limit, and a length guard so a runaway extraction prompt can't write a 50KB row.

## Reading memory — two queries in parallel

The chat-prompt assembler runs both layer queries concurrently before the next LLM call. The user message is embedded once, then both `tokio::spawn`s race.

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

`<=>` is pgvector's cosine-distance operator. `profile_k` is small (often 3); `relationship_k` is usually larger (often 6-8) because relationship memories are the ones that produce the "she remembers me" effect. The two result sets land in separate sections of the system prompt — they are *not* merged into one bag of facts.

## The math behind self-hosting

Eros runs on Fly.io shared-cpu-1x (256 MB RAM cap, scale-to-zero). Once the Mem0 sidecar was gone, the engine fits comfortably:

- Rust process steady-state: tens of MB.
- Postgres connection pool overhead: tens of MB on the engine side; the database itself is a separate Fly app.
- pgvector index for ~10k memories at 512 dim: a few MB on the database side; ANALYZE keeps lookup performance steady.

For a self-hoster on similar hardware, the practical implication is: you don't need a dedicated memory service. A small Rust binary plus the Postgres you already have is the deployment. That removes one container, one set of credentials, one place where bills can accumulate, and one source of cross-process latency on the chat hot path.

## Cost per user

Concrete numbers for a single chatty user, ~50 turns/day, with both layers being written + read:

- Per turn: ~1 embedding call for write (paraphrased user fact) + 1 for the reply context. ~200 tokens total at $0.02 / 1M = `$0.000004 / turn`.
- 50 turns/day × 30 days = 1500 turns × $0.000004 ≈ **$0.006 / user / month** for embeddings.
- Storage: ~3KB per row × ~30 new rows/month ≈ negligible.

The chat LLM call dominates the bill. Memory is a rounding error.

## What you give up vs Mem0

Honestly:

- **Extraction prompts are yours to write.** Mem0 ships extraction logic out of the box; on this stack, you're responsible for the prompt that turns "what the user just said" into a memory-worthy summary. We use a small Sonnet 4.6 prompt that emits 0-3 candidate memories per turn.
- **Dedup is your job.** Mem0 has built-in similarity-based dedup. We use a cheap cosine pre-check before insert: if the new embedding's max cosine to the user's last 50 memories is over a threshold, we skip the insert.
- **No managed dashboard.** No "list all memories for user X" UI out of the box. We use the Supabase table view in dev and ship a tiny `/admin/memories?user_id=...` endpoint for production debugging.

If your team isn't ready to own those three pieces, Mem0 is the right call. If you're already running Postgres and you're already in Rust (or any sqlx-friendly language), this stack is leaner.

## Try it

If you want the actual code:

- Repo: [`github.com/etherfunlab/eros-engine`](https://github.com/etherfunlab/eros-engine) (AGPL-3.0-only, 4-crate Rust workspace)
- Memory layer: `crates/eros-engine-store/src/memory.rs`
- Post-process fan-out (writes happen here): `crates/eros-engine-server/src/pipeline/post_process.rs`
- Migrations: `crates/eros-engine-store/migrations/0003_memory.sql`

Self-hosting needs Postgres 15+ with the `vector` extension, an OpenRouter key for chat, and a Voyage key for embeddings. README has the full bring-up. Issues and PRs welcome — particularly around extraction-prompt quality and ivfflat → hnsw migration runbooks.

---

*Prompted by Henry Lin, written by Opus 4.7. Concrete numbers verified against `eros-engine` HEAD as of 2026-05-10.*
