---
title: eros-engine memory upgrade — putting the user profile in drawers
description: Yesterday's post mentioned a `category` column in the schema, but nothing was actually filling it. PR #5–#8 fixed that. This is the engineering follow-up — how the dreaming-lite background pipeline scans idle sessions, extracts and classifies with Haiku 4.5, and writes to the profile layer in a multi-instance-safe way; plus where time decay and importance scoring fit in next.
date: 2026-05-11
tags: [eros-engine, memory, rust, dreaming, postgres, ai-companion]
draft: false
lang: en
---

[Yesterday's post](/posts/2026-05-10-pgvector-voyage-companion-memory/) showed a schema with a `category TEXT` column. The column does exist in production migrations (`0006_memory_category.sql`). Honest disclosure, though: nothing was *using* it. No write path was setting it, no retrieval path was reading it — every row had `category = NULL`. The line at the end of that post about "a small Sonnet 4.6 prompt that emits 0-3 candidate memories per turn" was the same: *forward-looking* design intent, not running code. The actual production engine when that post went out was: every chat turn ended by inserting the user's raw half-sentence into the profile layer as that user's "profile". That's not a profile. That's a raw turn dump.

PR #5–#8 made both promises real. This post is the engineering follow-up: what got built, why a background dreaming pipeline is needed at all, and how the next pass — time decay and importance scoring — will look.

## What the profile layer actually was, before

First, separate "profile memory" from "relationship memory." Profile is *who this user is* — shared across all persona instances. Relationship is *what happened between her and this specific persona* — one-to-one continuity. Both layers retrieve by cosine and land in different sections of the system prompt.

Pre-upgrade, the profile write path went: at the end of each turn, the post-process fan-out inserted `user: <half-sentence>` directly into `engine.companion_memories` with `category = NULL`. Retrieval pulled top-K by cosine and joined the bullets into the prompt's "what you know about her" block.

It worked, but it had three problems:

1. **No extraction.** "I worked till 10 again" is a raw sentence, not a fact. The thing worth remembering long-term is "she's been under work pressure recently." The model saw a pile of raw sentences each turn and had to reconstruct structure on the fly.
2. **No classification.** "Lives in Shanghai," "likes jazz," "broke up last week," "her mother is pressuring her to marry" — four facts with very different semantic weights, all sorted by the same cosine into the same bullet list. When the model wanted to "ask about her work," what it sometimes retrieved was "lives in Shanghai."
3. **Schema had structure but nothing used it.** The `category` column was in the schema but no writer was setting it and no retrieval was reading it; the extraction-prompt paragraph at the end of yesterday's post was the same — *forward-looking design intent*, not the running code.

## PR #5–#8

The four PRs that closed this loop:

- **PR #5** — wired the existing `category` column through to the Rust side: `MemoryRepo::upsert/search/MemoryRow` got an `Option<&str>` category parameter end-to-end. Writers pass `None` for now (the raw-turn writer has no category info to fill). The point was to lock the interface shape so PR #6's classifier could plug in without a backfill.
- **PR #6** — new `pipeline::dreaming` module (with 7 unit tests). A tokio background sweeper: scans idle sessions (30 min of silence), runs an LLM extraction + classification step, writes results back to the profile layer.
- **PR #7** — retrieval renders by category. A single `ROW_NUMBER() OVER (PARTITION BY category)` query takes the top-2 per category (5 categories), and the prompt now has labeled subsections like `[fact]` / `[preference]` / `[recent event]` / `[emotion]` / `[relationship]`.
- **PR #8** — sweeper picker rewritten as `UPDATE ... WHERE id IN (SELECT FOR UPDATE SKIP LOCKED) RETURNING ...`, multi-instance safe with crash recovery (a stuck claim gets re-grabbed by another worker after the `claim_stale` threshold).

Together this is **dreaming-lite**. Lite because it only does *extraction + classification* — not cross-session merging, dedup, or generalization. That's the territory of "real dreaming," and it's where this is heading next.

## Why dreaming exists at all (even the lite version)

Direct answer: you can't use raw sentences as a profile. The deeper question is *when* extraction should happen.

The most naive option is per-turn extraction — every user message triggers an LLM call to extract facts and write them. We didn't pick that, for three reasons:

1. **Breaks the cost story.** Yesterday's post said "memory is a rounding error" — embedding at $0.000004/turn is genuinely negligible. Adding a Haiku 4.5 call per turn (cheap as it is) puts you back in the world where memory has a noticeable bill. Session-end triggering compresses N turns into one LLM call.
2. **Extraction needs context.** "I worked till 10 again" alone is an event. But if her previous turn was "my boss dropped another spec on me," the long-term-worthy fact is "she's been under work pressure + boss is the source." Per-turn extraction can't see the whole session, so it produces fragmented and redundant facts.
3. **Natural fit with future "real dreaming."** What we eventually want is an offline pass over a full session that extracts facts, merges similar memories, and generalizes — the actual "dreaming" metaphor, the agent "sleeping on it" overnight. Session-end + background sweeper is already that shape; consolidation is one more pass over the same skeleton.

Concretely: 30-min silence marks a session ended; a tick every 5 min picks up unclassified sessions. Haiku 4.5 (not Sonnet 4.6 — extraction + classification is a structured "regular task," and there isn't enough demonstrated lift to justify Sonnet's price tag). Each session emits 0-10 `{content, category}` candidates, each one embedded by Voyage and written to the profile layer.

Five fixed categories: `fact` / `preference` / `event` / `emotion` / `relation`. The LLM occasionally invents a category; `normalise_category` collapses unknown values to `fact` so the partitioned retrieval doesn't blow up under high cardinality.

## The multi-instance safety cut

A background sweeper means that if the server runs with multiple replicas, the same batch of idle sessions is visible to multiple workers at once. The first pass was `SELECT ... ORDER BY ... LIMIT 10` followed by `UPDATE` — a cross-statement race. Two workers grab the same session, run two LLM calls, write two duplicate memory sets.

PR #8 collapsed it into a single statement:

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

`$1` is `now() - idle_threshold`, `$2` is `now() - claim_stale_threshold`, both computed on the Rust side before binding.

`FOR UPDATE SKIP LOCKED` is Postgres's concurrency primitive: rows already locked are *skipped*, not blocked, not errored. Concurrent workers running this statement get disjoint subsets of sessions. `classification_claimed_at` and `classified_at` are deliberately separate columns: claimed = in flight, classified = done. If a worker dies mid-flight, after the 10-min `claim_stale` threshold the session becomes re-claimable by another worker.

One detail worth flagging: even when the LLM extracts 0 candidates / parse fails, we still stamp `classified_at = now()`. Otherwise a poison-pill session loops forever and burns sweeper quota. Only network errors skip the stamp, so they retry naturally.

## The cost math

For a single chatty user with dreaming-lite running:

- 50 turns/day, ~10 turns per session → ~150 sessions / month
- One Haiku 4.5 call per session (~1500 input tokens, ~200 output) ≈ $0.002, plus N Voyage embeddings per session for the candidate memories (each ~$0.000002 — still negligible in dollar terms)
- 150 × $0.002 ≈ **$0.30 / user / month** (dreaming)
- Plus the chat path's existing $0.006 / user / month for embeddings

Two orders of magnitude above embeddings, but still small change next to the chat LLM bill itself (typically $5-10 / user / month). Acceptable.

## Next: time decay + importance scoring

dreaming-lite fixes "the profile has no structure," but retrieval ranking is still cosine-distance-only. Two obvious next passes:

**Recency decay.** Within a category, current ranking is plain cosine distance, top-2 per category. The problem: when "she said she lives in Shanghai" (last year) and "she said she moved to Tokyo" (last week) both exist, cosine doesn't prefer the newer one — it picks whoever is closer to the query embedding. The plan is to switch the ranking key to similarity (i.e. `1 - <=>` cosine distance, higher is better) and add a recency term: `score = sim + λ · exp(-age / τ)` with τ on the order of weeks. Old facts decay rather than getting hard-deleted (in case retrieval genuinely needs historical context).

**Importance scoring.** The fixed quota of 2 per category treats "her mother pressuring her to marry" (relation) and "she likes mocha" (preference) as equal-weight. The plan is to have dreaming emit `importance: 0-1` alongside category, and rank retrieval by `sim × decay × importance` (same similarity basis) against a *global* top-K rather than a per-category quota. This one needs real traffic to tune — any weights picked before user feedback are guesses.

Further out is "real dreaming" — periodic scans over high-cosine-similarity rows within `(user_id, category)`, LLM-merged into single canonical entries. Multi-session traffic will produce duplicates like five `category=fact` rows all saying "lives in Shanghai." That's expected; the trigger to actually build consolidation is user feedback ("memory feels muddled") or measurable duplicate-fact ratios in the prompt.

Which one ships first depends on real traffic signals from eros-chat. Until then engine work is paused — focus is on the frontend.

## Try it

Code lives at [`github.com/etherfunlab/eros-engine`](https://github.com/etherfunlab/eros-engine), AGPL-3.0-only:

- Dreaming module: `crates/eros-engine-server/src/pipeline/dreaming.rs`
- Migrations: `0006_memory_category.sql` / `0007_session_classified_at.sql` / `0008_session_classification_claim.sql`
- Grouped retrieval: `MemoryRepo::search_profile_grouped` in `crates/eros-engine-store/src/memory.rs`
- Sweeper config: `DREAMING_TICK_SECS` / `DREAMING_IDLE_SECS` / `DREAMING_CLAIM_STALE_SECS` (`state.rs`)
- Disable: `DREAMING_DISABLED=1`

Self-hosting needs an OpenRouter key (chat + dreaming share it) and a Voyage key. To validate sweeper behavior locally, run with `DREAMING_TICK_SECS=10 DREAMING_IDLE_SECS=30`, do a couple of turns, wait 30 seconds of silence, and check `engine.companion_memories.category` for non-NULL values.

---

*Prompted by Henry Lin, written by Opus 4.7. Concrete numbers verified against `eros-engine` HEAD as of PR #5–#8 landed on 2026-05-10.*
