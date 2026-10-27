---
title: "How Insights 2.0 got built: six steps from brainstorm to production"
description: "eros-engine v2.4.0 replaced its per-turn user profile rewrite with a fact ledger and scheduled rebuilds. This post walks through how it was built: six steps, four repos, and one agent session per repo, where every handoff was a document the next step could read."
date: 2026-10-27
tags: [eros-engine, agent-workflow, claude-code, llm, insights]
draft: false
lang: en
---

[eros-engine](https://github.com/etherfunlab/eros-engine) is our open-source AI companion engine, written in Rust. [v2.4.0](https://github.com/etherfunlab/eros-engine/releases/tag/v2.4.0), released on October 27, ships Insights 2.0: a rewrite of how the engine builds a profile of the human user from conversation.

The implementation is documented in the repo, in [`docs/insights.md`](https://github.com/etherfunlab/eros-engine/blob/main/docs/insights.md) and the [design spec](https://github.com/etherfunlab/eros-engine/blob/main/docs/superpowers/specs/2026-10-26-insights-2-fact-ledger-design.md). This post covers how it was built. From the first brainstorm commit to picking the rebuild model after launch took about 42 hours, six steps and four repos. Each repo had its own Claude Code session. Sessions share no context with each other; every handoff went through a document or a message.

We have written this way of working up as a public repo, [etherfunlab/workflow](https://github.com/etherfunlab/workflow). This post is one worked example of it.

## What changed

In 1.0, every conversation turn ran two stages. Stage one extracted facts from the turn. Stage two handed those facts, together with the user's entire existing profile, to a model and asked for the full updated profile back, which the engine then merged in by non-empty value.

We measured that pipeline on data from a production deployment and found four problems:

- **Every turn rewrote the whole profile.** Over six weeks, 99.4% of the non-empty keys stage two wrote were keys that already had a value; in a sample, more than nine in ten came back unchanged. The median turn added one new fact and re-emitted eight keys.
- **Bigger profiles truncated more.** The model had to write the old profile back out in full, so a large profile pushed the reply into `max_tokens`.
- **Two-thirds of facts had nowhere to go.** 65.6% of extracted facts fell in domains the schema had no field for.
- **Schema examples leaked into profiles.** The 1.0 schema explained its format with concrete examples, and some users ended up with an occupation or city byte-identical to one of them.

What 2.0 does instead:

| | 1.0 | 2.0 |
|---|---|---|
| Where facts live | only in the audit log | a `human_facts` ledger, deduplicated on normalized text, with occurrence count, session count and first/last seen |
| Input to the profile call | this turn's facts plus the whole old profile | the whole ledger, ranked by occurrences and recency, cut at 16,000 characters; the old profile is not read |
| When it runs | every turn that produced a fact | after 20 facts (new or repeated), or after an hour of quiet |
| What the model writes | the whole profile, merged by non-empty value | the whole profile, which replaces the row |
| Schema | concrete example values | `<…>` slots only; geography, preferred gender and age range removed; `kinks`, `ideology`, `mental_health` and `education_level` / `education_status` added |

## Six steps

All times are UTC.

### 1. Measure the problem first (reports repo, Oct 26 01:24)

The reports repo is private and holds brainstorms, dev-logs and weekly reports. The brainstorm started by measuring 1.0 on a production snapshot; most of the four problems above come from it, while the cause of truncation and the "unchanged values" sample were added by the phase 1 experiment later. It then settled the architecture, a fact ledger with a derived profile, and listed six experiments for the audit repo, each with the question it had to answer.

No code was written at this step. What it handed on was a list of problems with numbers attached and a list of hypotheses to test.

### 2. Take stock and run the audit (reports repo + audit repo, 01:33 to 02:57)

The audit repo is also private. It runs production data analysis and paid experiments, with read-only access to the production database. Two lines of work ran at once here.

One was a stock-take of the current state: geography fields, nationality, copied examples and the matchmaking fields, checked one by one, with the findings written back into the brainstorm.

The other was an audit report that replaced the brainstorm's hypotheses with measurements:

- **How often to rebuild.** Replaying seven weeks of historical facts against candidate triggers, "20 facts or one quiet hour" came out at 86% fewer calls than 1.0, with new facts reaching the profile within about 1.1 hours at p90.
- **How much ledger to feed in.** A 16,000-character budget fits 98% of users' whole ledgers, with a single input of at most about 10k tokens.
- **Whether to merge facts by embedding.** No. After two judge models and a founder check of 30 pairs, merging at cosine 0.94 lost a detail in roughly one merge in nine, for little gain. The ledger only merges exact matches.
- **Whether to keep stage one's persistence label.** The brainstorm planned to have the engine derive it from occurrence counts. The audit found 97.7% of ledger rows had been seen exactly once, so count-based tiers would put nearly everything in one bucket. The model's label stays.

The audit report went through three passes before it was final: fact-check, polish, and a final review by a different model family.

### 3. Model selection, phase 1 (reports repo + audit repo, 03:56)

The rebuild model was chosen in two phases. 2.0's prompt would not exist until the engine was written, so phase 1 ran on 1.0's stage two: 118 sampled turns, replayed on four models. One model was dropped, one was kept only as a ceiling reference, and two went on to phase 2, to be compared on the real prompt once the engine existed. Phase 1 also traced truncation to the input side: every truncation fell on turns where the old profile was very large.

### 4. Implementation (eros-engine, Oct 26 19:18 to Oct 27 07:54)

eros-engine is public. The engine session started from the three documents above: the brainstorm, the audit report and the phase 1 dev-log. It worked through the design with the founder, wrote the spec, broke it into a plan, then implemented it.

Some decisions were made only at this step. The largest was removing `preferred_gender` and the age range used for matchmaking. The brainstorm had planned to keep them and validate them on write. After looking at the data, the founder dropped them: a model cannot judge an age range from conversation, and about three in ten stored ranges were defaults like 0-0 or 18-99. The decision is recorded in the spec's Decisions section.

The implementation landed as one PR of 19 commits, 17 of them implementation, and v2.4.0 was tagged at 07:54. v2.4.1 followed that afternoon, dropping seven retired columns and renaming the audit table. Dropping columns took two releases, as the brainstorm had planned: 2.4.0 stopped reading and writing them, and the next release dropped them.

In the public repo, specs and issues never name private repos or internal URLs, and production evidence is always "a production deployment".

### 5. Wiring and deploy (web client repo, Oct 27 16:19 to 18:10)

The web client repo is private and holds deploy configuration. It put 2.4.0 on the test server first. The test server's first two rebuilds both stopped at exactly 1,200 tokens, so the rebuild's `max_tokens` went up to 4,000. Production switched to 2.4.0 at 16:40.

Of the first round of rebuild calls, a little over half wrote a profile, a little over four in ten came back empty, and 2% failed to parse; 10 of the 12 parse failures stopped at exactly 4,000 tokens.

One more operation after launch cost money: splitting old sexuality and health facts in the ledger into the new `kink` and `mental_health` domains. The web session treated it as a separate paid job. It reported the call count first, stopped once the labeling run finished, and reported the rows per new label, the users affected, failed batches and actual cost. Only after the founder approved did it write the results into the ledger. That write came after the first round of rebuilds; over seven thousand rows changed, and the affected users were queued for a fresh rebuild.

### 6. Model selection, phase 2 (reports repo + audit repo, Oct 27 18:19 to 19:50)

The web session wrote the live config, the first-round numbers and the constraints into a message and sent it to the reports repo's session.

Phase 2 used the prompt and the ledger renderer straight from the v2.4.0 source, read at the tag, not copied by hand. It replayed the production ledgers through both candidates. Before the paid run there was a gate on the first 10 users: the replay's prompt token count had to match the production rebuild's, or the run stopped. It did stop the first time. Three of the ten were off by a few tokens; two of those came from the timing of the reclassification in the previous step, the third was never traced, and since the gap was tiny a person looked at it and let the run continue.

On reliability the result was lopsided. On the same ledgers, the incumbent model kept writing `kinks` items on large ledgers until it was cut off, at 193 to 375 items; in 10 of the 13 cases the same items were repeating. The other candidate was never cut off, its longest reply was about 1,250 tokens, and it returned far fewer empty profiles. It has weaknesses of its own: it breaks more rules on a small set of edge-case ledgers, and more often writes personality and interest items with no support in the ledger. A blind human review of content quality has not been done yet. The founder switched the primary model on reliability. The conclusion went back to the web session, which opened the PR to change the config, and the change went live at 19:50.

## What made it work

**Pin the requirements before moving on.** Brainstorm, audit, spec, plan, implementation: each step built only on the previous step's documents, and every reversal has a source. This is the "constraints first" principle in the workflow repo.

**Documents are the handoff.** The engine session started from three documents; phase 2 started from one message. Because sessions share no context, each step had to write its conclusions so that someone else could read them.

**One authority.** Phase 2 did not use the draft prompt from the audit stage, because the engine wrote its own and the engine's is the one running in production. The replay read the source at the release tag.

**Cut numbers at deploys.** The production baseline starts at the moment v2.4.0 went live; nothing before it counts.

**Repos have boundaries.** Analysis repos are read-only against production. The reports session does not edit the web repo; it sends its conclusions over. Cross-repo problems become issues, like [#463](https://github.com/etherfunlab/eros-engine/issues/463).

**Paid experiments run one round at a time.** Each round starts with a call count and cost estimate, and a bad result goes back to a person instead of into another round with a tweaked prompt.

**Judgment stays with people.** Which experiments to cut, which fields to drop and which model to run were all the founder's calls, made after seeing the data. The agents' job was to lay the data out clearly.

**Three passes before anything is final.** Fact-check, polish, and a final review by another model family. This is the publish module in the workflow repo.

## The first iteration after launch

A problem showed up on launch day. The profile's array fields had no item limit, so heavy users' replies ran into `max_tokens` and the JSON failed to parse. We opened [#463](https://github.com/etherfunlab/eros-engine/issues/463), proposing a per-field item cap in the prompt, the same cap enforced on write, and compact JSON output.

Phase 2 gave it direct evidence. Every truncation had the same shape: one array that would not stop. The issue could only see the first 2,000 characters that were stored, and judged the reply "long, not looping". With the full replies in hand, 10 of the 13 truncated arrays turned out to repeat the same items over and over, so the fix needs deduplication as well as a cap; that correction is now a comment on the issue. Switching the primary model leaves truncation only on the fallback path, and the fallback is the old model, so the fix is still needed.

Phase 1 had called truncation an input problem. That referred to 1.0 having to rewrite the whole old profile, and 2.0 removed that cause by not reading the old profile at all. A runaway array on the output side is a separate problem.

## Where things stand

As of October 27, 2026, 20:00 UTC:

- Our production deployment runs v2.4.1, with the new primary model for rebuilds and the old one as fallback. The latest release is v2.5.0, not yet deployed.
- The new primary was chosen on reliability; the blind human review of content quality is still to come.
- The engine has a user erasure endpoint; it is not wired up in production yet.
- The 86% fewer calls and the 1.1-hour p90 delay are still simulation results from the audit. Production measurements need a full week of traffic.
- #463 is still open.

---

*Prompted by Henry Lin, written by Opus 5.5.*
