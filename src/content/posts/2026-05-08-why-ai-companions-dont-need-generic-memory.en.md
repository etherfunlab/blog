---
title: Why AI companion products don't need a generic memory layer
description: We removed Mem0 from eros-engine and rebuilt the memory layer on pgvector + Voyage. This post explains why AI companions need a relationship-shaped memory system, not a generic facts store.
date: 2026-05-08
tags: [eros-engine, memory, rust, pgvector, ai-companion]
draft: false
lang: en
---

The first version of [`eros-engine`](https://github.com/etherfunlab/eros-engine) used Mem0 for long-term memory. We later removed that dependency and rebuilt the layer on Postgres + pgvector + Voyage embeddings, pulling memory writes, retrieval, and the post-process pipeline into our own Rust workspace.

This wasn't just a vendor swap. After the migration, one thing became clearer: the memory abstraction an AI companion product needs is not the same as a generic agent memory layer.

## What generic memory layers solve

The typical abstraction in Mem0, Letta, Zep and similar layers is:

```txt
user_id / agent_id / app_id / run_id -> extracted facts -> semantic retrieval
```

That fits customer-support bots, RAG agents, document assistants, and workflow automation well. The system extracts preferences, constraints, and task context from conversation, then retrieves them on the next turn. For these scenarios, remembering "this user is allergic to peanuts" or "this customer is on the Enterprise plan" is already worth a lot.

An AI companion's core goal is different. The moments when a user feels "she remembers me" usually aren't a single isolated fact firing — they're a fragment with emotional charge and relational position being echoed back:

- The context an old argument took place in.
- Why the user fell silent on a particular night.
- A joke that only works inside this relationship.
- A nickname that started as cautious, then drifted into the default.

These aren't `facts`. They're closer to relationship state and episodic memory: tied to a session, a persona, an emotional curve, an intimacy trajectory, and the question of "where has this relationship gotten to."

## Companion memory needs two semantic layers

In `eros-engine`, long-term memory splits into two layers:

| Layer | Scope | Purpose |
|---|---|---|
| Profile memory | `user_id` | Cross-session, cross-persona user profile — preferences, identity facts, long-term constraints |
| Relationship memory | `user_id + persona instance` | Memory specific to this user × this persona pair — shared experiences, in-jokes, conflict and repair |

You can simulate both scopes inside a generic memory system using entity filters, but the semantics are not equivalent. Profile memory primarily serves user profiling and downstream recommendation; relationship memory primarily serves the continuity of *this* persona. They differ in write timing, retrieval count, prompt-injection position, and decay strategy.

This is also why we ultimately did not extract the memory layer into a standalone SaaS: for a companion product, memory retrieval isn't a feature an isolated API can fully express — it's a step inside the chat pipeline. It works in tandem with prompt assembly, affinity update, ghost decision, and insight extraction.

## Why we removed Mem0

The migration wasn't because Mem0 doesn't work. It's because it solves a more general problem. Once embedded in a companion engine, several engineering constraints became hard to ignore.

**Latency path is uncontrollable.** Each chat turn already has a primary LLM call; putting memory search behind a separate cloud service adds another RTT to the synchronous path. After the migration, retrieval is a pgvector query inside the same Postgres, and p95/p99 are far easier to optimize on the production path. In our internal tests, what used to be ~200ms external search RTT dropped to ~5ms local DB.

**Debug boundaries are unclear.** A generic memory layer owns extraction, dedup, merging, and retrieval — convenient for early product iteration. But when production hits "why did this memory disappear?" or "why didn't this new fact get merged in?", the black-box behavior slows root-cause analysis. In the pgvector version, a memory is a row in `engine.companion_memories`. Merge thresholds, categories, source messages, and soft-delete are all our own schema and SQL.

**Rust integration cost isn't trivial.** Mem0 is Python-first. We previously maintained a REST wrapper inside `eros-gateway`; whenever the schema drifted, the deserializer became a single point of failure. After moving to Postgres, `sqlx::query_as!` checks SQL shape at compile time, and the boundary is much more stable from the Rust side.

**Open-source users shouldn't be forced into a third-party SaaS.** `eros-engine` is meant to be a self-hosted AI companion engine. Binding the core memory layer to a managed SaaS adds an account, a bill, and a data boundary that a self-hoster has to deal with. The pgvector approach only depends on a Postgres extension and an embedding provider — much more in line with the deployment model we want to offer.

Cost also shifts from a fixed external bill to something closer to usage-linear token cost. As of 2026-05-08, Mem0 Cloud's published pricing is no longer the early `$99/month` starting tier mentioned in older materials; Voyage `voyage-3-lite` embeddings are billed per token at `$0.02 / 1M tokens` with 512-dim output. For a self-hosted engine, that cost model lines up much better with actual chat volume, memory extraction volume, and database scale.

## How the pgvector version is built

The core table simplifies down to:

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

`instance_id IS NULL` means the profile layer; `instance_id = <persona_instance_id>` means the relationship layer. One table carries both semantics, distinguished by predicate at query time — no need to maintain two schemas.

Writes happen in the post-process stage. The chat main path completes the LLM reply and returns to the client first; a background task then runs memory extraction, embedding, and insert. This keeps memory-write failures from blocking the user's reply, and keeps embedding-provider jitter out of chat response time.

Retrieval happens before prompt assembly. The system embeds the current user message once, then queries both layers in parallel: profile layer pulls a small number of long-term traits; relationship layer pulls fragments tied to the current persona. The two result sets are injected into separate sections of the system prompt, not mashed together as one bag of "relevant facts."

The key in this implementation isn't the line count — it's the boundary:

| Dimension | Generic memory SaaS | `eros-engine` built-in memory |
|---|---|---|
| Data model | Generic entity scope | Profile / relationship product semantics |
| Retrieval site | External API call | Step inside the chat pipeline |
| Debugging | SDK / dashboard | SQL / trace / app log |
| Cost model | Managed-service price | Postgres + embedding tokens |
| Extension point | Provider feature | Rust code + schema migration |

## Why we don't ship "open-source Mem0"

After the pgvector migration, a natural thought is to wrap it as a standalone memory service: add `/memory/search`, `/insight`, multi-tenant namespacing, quota, API key, and pitch it as a Rust-flavored Mem0.

We didn't.

The reason is simple: that would put the product's core complexity in the wrong place. Memory in an AI companion isn't a feature the user calls explicitly, and it isn't an isolated developer API; it's part of the relationship state machine. It influences how the persona speaks, whether to reply at all, when to back off briefly, how a gift reaction should land in the affinity vector, and what context the next prompt should carry.

If we were to slice memory out of the pipeline as a SaaS, we'd spend significant engineering on tenancy, quota, namespacing, billing, and public-API compatibility — while the developers actually building companions, coaching, journaling, or language-tutor products would benefit far more from a crate and schema they can embed directly into their own pipeline.

So `eros-engine` is positioned as an AI companion engine, not a generic memory layer. The memory system is one capability of the engine, working alongside affinity, the PDE, and post-process fan-out to produce the product experience.

## Where it sits today

`eros-engine` is a 4-crate Rust workspace:

| Crate | Responsibility |
|---|---|
| `eros-engine-core` | Pure logic — the 6-dim affinity vector, ghost decision, the PDE |
| `eros-engine-llm` | OpenRouter chat client, Voyage embedding client, per-task model config |
| `eros-engine-store` | Postgres + pgvector persistence, tables under the `engine` schema |
| `eros-engine-server` | Axum HTTP server, Supabase JWT middleware, pipeline orchestration |

The memory layer lives mainly in `crates/eros-engine-store/src/memory.rs`, called from the server pipeline's post-process stage. Writes for `affinity / memory / insight` run in parallel after the reply is returned; the main chat path keeps only the necessary reads and LLM generation.

This makes the memory layer an observable, migratable, and prunable internal module — not a service you have to deploy and operate separately.

## When this design fits

The design fits products where the same persona and the same user interact for a long time:

- AI companion / AI character chat
- journaling companion
- coaching agent
- language tutor
- vtuber interactive chat

It is not necessarily right for general-purpose agent products. If your system's goal is task completion — customer support, enterprise RAG, document Q&A, workflow automation — generic memory layers like Mem0 / Letta / Zep are still the more direct abstraction.

The deciding question: is memory there primarily so the agent can **complete tasks more accurately**, or so the persona can **form a continuous relationship with the user**? The former is well-served by a generic memory layer; the latter should keep memory as an internal state of the companion engine, not as an external database.

---

Code at [`github.com/etherfunlab/eros-engine`](https://github.com/etherfunlab/eros-engine). `eros-engine` is currently AGPL-3.0-only; self-hosting requires Postgres + pgvector, OpenRouter, and a Voyage API key. Upcoming posts will dig into the 6-dim affinity EMA, ghost streak protection rules, and the PDE decision layer.

---

*Prompted by Henry Lin, written by Opus 4.7 and revised by GPT-5.5.*
