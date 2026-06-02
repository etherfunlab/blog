---
title: From 3 to 16 locales — an i18n translation workflow paired between Claude Code and Codex CLI
description: "Two weeks scaling a Nuxt 4 project from 3 to 16 locales. This post is about the concrete craft decisions — which step belongs to Claude Code, which to Codex CLI, why they don't mix, how to recover when two parallel codex writers silently trample each other's directories, and one underlying rule that runs through every translation flow we use: whoever writes, the other reviews."
date: 2026-05-19
tags: [i18n, nuxt, vue, claude-code, codex, agent-workflow]
draft: false
lang: en
---

One of our Nuxt 4 frontends (Eros Chat, the open registration surface for our AI-companion product) went from 3 locales to 16 over the past two weeks.

The starting set was `zh / zh-hant / en`. We then shipped, one by one: `ja, ko, de, es, fr, ru, pt-br, pt, vi, el, th, it, nl`. Each locale carries about 14 surface JSON files (landing / chat / account / web3 / seo / …) in the frontend; that's 200+ JSON files total, plus a `cities` dataset, plus several UI cross-cuts (navbar, LocaleSwitcher, font loading, etc.).

The raw volume isn't the interesting part. What's worth writing down is the craft — how the first round's ad-hoc translation, the second round's stumbles, and the third round's outright reversal eventually converged into two reusable playbooks: **add-language** and **add-key**. Claude Code and Codex CLI each carry part of the work. The split isn't a "which is smarter" question. It's a "which work-shape fits which tool" question.

## The underlying logic of the tool split

Claude Code and Codex CLI look superficially similar — both are terminal-resident AI coding agents, both can read / write / execute commands. In i18n work specifically, their work-shape differences become sharp on three axes:

- **CLI startup cost.** Every `codex exec` spawns a fresh process: sandbox, repo read, context load. Roughly 1–2 seconds of overhead per invocation in our runs. Claude Code runs in a long persistent session — no per-edit process startup.
- **Write scope.** `codex exec -s workspace-write` makes its **working root** writable — and in our setup that root was the whole repo, with the target locale pinned only in the prompt. So "stay inside `i18n/locales/X/`" was an advisory instruction, not a sandbox boundary. (More on this later — it's the root cause of the race condition.) Claude Code's tool calls go through the main session: every file edit is visible and traceable.
- **Batch vs. micro-edit.** Codex is shaped for "one big prompt, one pass over ~14 files." Claude Code is shaped for "small edits across many files, run tests, adjust, re-run."

In i18n terms, the rule of thumb is:

> **Single-task scale × need for test-feedback loops ≈ which tool to use.** Large, single-pass batch → codex. Small, iterative, test-driven → Claude Code.

But there's a more important meta-rule that runs through both flows. We'll save it for the middle of the post. First, the two workflows themselves.

## Adding a new language: codex writes, Claude reviews, codex sweeps

When you add a fresh locale, the target directory is empty and you need to fill ~14 JSON files from zero. That's a textbook "one big prompt, one pass" job — codex as the primary writer is the most economical choice. But codex output has two characteristic failure modes:

1. **Format drift.** vue-i18n tokens (`{name}`, `{count}`) sometimes get "localized" into native-script substitutes, or the spaces around them get squeezed out. The drift is invisible in languages with inter-word spaces (English, German, Spanish), but in Thai — which has no inter-word spaces — it becomes the highest-risk regression vector.
2. **Register drift.** Most visible in Japanese / Korean — codex sometimes drifts between polite and plain forms within the same file. Russian informal vs. formal has the same issue.

So each first-translation pass is a three-stage chain:

```text
1. codex exec runs the first pass (all 14 JSONs in one go)
2. Claude subagent runs spec-review:
   - key parity (zero missing keys vs. en)
   - token preservation ({name}-style tokens byte-exact, including
     surrounding whitespace)
   - register / orthography (per-locale rules, e.g. Thai uses คุณ
     consistently and never falls into ครับ/ค่ะ)
   - brand terms verbatim (Eros³, Web3, NFT, SOL, Affinity Mechanism,
     etc.)
3. codex runs cross-cutting review: sweeps for cross-surface
   calques — "translated correctly but not how a native would say it",
   literal renderings of idiomatic source phrases
4. Main agent applies fixes, commits
```

Stage 3 is the expensive one to skip. Stage 2 is rule-driven and Claude excels at that — given a spec, mechanically check it. Stage 3 is about *how it reads as a whole*: the same brand phrase appearing in three places at three different degrees of literalness, an entire paragraph that's grammatically clean but reads like translation rather than original copy, a register that's internally consistent but doesn't match how natives actually phrase product UI. That kind of judgment requires a different context from the one that wrote the file. A fresh codex session is the cheapest way to manufacture that.

After about six locales, the three-stage chain stabilized — almost no surprises. The notable exception was Thai's first translation, where we let the whole chain run agent-autonomous with no human in the loop. Stage 3's cross-cutting review surfaced 11 candidate fixes; the agent itself triaged them: 5 high-confidence repairs (including a Thai spacing rule around `และ` and a defensive reorder for Latin-name + Thai-word fusion) got merged in, 6 stylistic-only candidates were explicitly deferred, and one outright semantic rewrite (changing "Texture" to a different concept) was explicitly rejected. It was a clean validation that the chain converges even in the single-language case where you don't have sister-locale parallels to cross-check against.

## The reverse: when adding keys, Claude writes, codex reviews

A new feature ships with a handful of new i18n keys — those keys need to land across 16 locales. The work-shape is the opposite of adding a new language:

- Each locale only gets a few keys changed (small fan-out × many locales);
- It's not one big prompt; it's a few strings inserted in each of a dozen directories;
- Starting up codex once isn't amortized across that little work.

Our first assumption was "let Claude handle add-key directly" — Claude opens the 13 directories in its session, writes a few lines into each, done in one shot. Two attempts in we realized that was wrong. Claude alone, running a 13-locale add-key pass, reliably misses two classes of problems:

- **Register drift.** Occasional informal-vs-formal slip in Russian, European-vs-Brazilian Portuguese conjugation crossover, occasional du/Sie inconsistency in German.
- **Calque (stilted literal translation).** The same brand phrase gets rendered at different degrees of literalness across locales — invisible inside one locale, visible only when you line up 13 side by side.

Why does Claude miss them? Because **inside any one locale Claude stays self-consistent** — the line is grammatically clean and lexically fine. The problem only surfaces when you cross-cut all 13 locales and check each against the register of that locale's existing keys.

The corrected add-key flow:

```text
1. Human writes zh as ground truth
2. Claude writes en, codex writes zh-hant (parallel — disjoint paths,
   and each playing its strongest language)
3. Claude writes the remaining 13 locales sequentially in one session
   (small fan-out, no subagent dispatch)
4. codex cross-reviews the uncommitted diff
5. Claude applies codex's NEEDS_CHANGES (usually 2–5 targeted string
   fixes); pure style suggestions get noted in the commit message but
   not blindly applied
6. One commit lands the batch
```

Step 2's "Claude writes en, codex writes zh-hant" parallel is a tiny but useful piece: Claude's English voice is cleaner than codex's; codex's Traditional Chinese (glyph choices, HK/TW idiomatic differences) is cleaner than Claude's. After step 2, the remaining 13 locales source from `en` (only `ja` / `ko` derive from `zh`), so Claude carries the en context forward smoothly into the rest.

Step 4 pulls codex back in for a fresh-context sweep — the same maneuver we use in stage 3 of the add-language flow.

## The meta-rule that runs through both flows

Lay the two flows side by side:

| Work shape | Writer | Reviewer |
|---|---|---|
| Add new language (batch first pass) | codex | Claude (spec) + codex (cross-cutting) |
| Add key (small fan-out) | Claude | codex (cross-review) |

**Whoever writes, the other reviews.** That rule is more important than the tool split itself.

The reason is mechanical. Review is either spec-checking or fresh-context "how does this read as a whole" inspection. The same agent reviewing its own work brings its writing assumptions with it: it can still mechanically check a spec, but the cross-context "should this even be phrased this way" reading is dead on arrival. Only a separate agent in an independent context can generate that reverse pressure of "why is this written this way; should it be that way instead?"

This generalizes well past translation. Our Nuxt + Supabase auth migration ([previous post](/posts/2026-05-13-nuxt-supabase-ssr-cookies)) used the same shape: Claude Code as main driver, codex as a second reviewer at every consequential decision point, codex never shown the main driver's conclusion.

So we don't actually think of this as "Claude Code + Codex dual-AI workflow." We think of it as **separation-of-write-and-review, with cross-context second review**. Translation is just where that separation is most tightly compressed.

## The silent codex race, and the four mandatory mitigations

Adding a language can be parallelized — say, dropping pt-br and pt (Brazilian and European Portuguese) into the same PR by running two codex translators concurrently.

Don't reach for that by default.

Our first attempt was exactly this — two `codex exec` runs, each targeted at its own locale directory. Both stdouts showed "translated N files successfully," both exited 0, no errors anywhere. But when we went to commit pt, the working tree had no diff. Files had been written at some point; they'd been silently overwritten or discarded during the parallel run.

Root cause: `codex exec -s workspace-write` lets codex write anywhere under its working root, and our working root was the repo — so "do not touch outside `i18n/locales/X/`" was a prompt-level instruction, not a sandbox boundary. When two runs race, agent B can read, partially write, and overwrite or discard the on-disk-but-not-yet-committed work of agent A — and you'll get exit 0, completion-looking stdout, no conflicts.

We hardened the rules into four mandatory mitigations. Every translator subagent prompt, when dispatching 2+ codex translators in parallel, must contain:

1. **"Sister locales are sacred."** Explicitly list, by path, the other locale directories running concurrently. Tell the agent: "do NOT touch `i18n/locales/<other>/`."
2. **Pre/post sister-stat comparison.** Before invoking codex, the subagent captures `git diff --stat i18n/locales/<sister>/` to a file. After codex, capture again. Diff the two. Any change = HARD FAILURE: abort, do not commit.
3. **Self file-count check.** The subagent reports the number of modified files in its own locale directory and asserts it equals N (the expected surface-JSON count). Codex occasionally silently emits partial output — thinks it's done but only wrote a subset. This catches that.
4. **Serial re-dispatch on trample.** If the main agent detects a sister-trample, the wiped locale is re-dispatched serially (not parallel), still with the sacred-sister guard.

The first time we ran this protocol formally was the it / nl pair (Italian and Dutch). Two codex translators on disjoint file sets, self-check passing, no trample, main agent landed it as a single commit. The pt-br/pt failure did not recur.

The stronger structural fix is to give each codex writer its own `git worktree` so they cannot physically see each other's files. But four soft-rule mitigations plus agent self-checks are adequate at our current throughput. We haven't put worktree-isolation work in front of other things.

## Phase-1 cadence: first commit only fills three locales

After both adds (language and key) stabilized, one workflow question was still being answered ad-hoc each PR: **how does i18n translation cadence interact with new-feature PR cadence?**

Our instinct at first: a new feature introduces new keys; translate all 16 locales before merging. Two PRs in we noticed this was double-bad:

1. **Review cognitive load.** A new-feature PR that simultaneously touches component / route / store / test + JSON for 16 locales — the diff drowns in translations, and code review can't see what the feature itself changed.
2. **Translation churn.** Feature copy gets adjusted during review. Every adjustment to the source string forces 16 locales to re-translate. That's a lot of codex / Claude billing for a string that's still in flux.

The corrected cadence:

> The first commit of a new feature **fills zh + zh-hant + en only**. The other 13 locales get a script-aware placeholder. After the code is finalized and the PR review is otherwise done, **one separate commit on the same branch fills the remaining 13 locales** in a batch, and then merge.

Placeholder choice matters — it determines what the PR review / preview deploy looks like in the meantime:

- **CJK fallbacks (`ja`, `ko`) ← copy from `zh`.** Latin placeholders dropped into a Japanese or Korean page break line-height, font weight, and reading flow. The Han characters in `zh` at least render in the right script family, even if the words are wrong.
- **Latin / Cyrillic / Greek fallbacks ← copy from `en`.** Same script family, so line-height and reading flow stay intact. **Thai also copies from `en`** — not because it shares a script family (it doesn't) but because runtime `fallbackLocale: 'en'` resolves to `en` anyway, so the preview matches what an end user sees.

Parity tests are layered correspondingly: `zh` / `zh-hant` are checked for strict key-set parity against `en`; other locales are subset-only (missing keys are fine, but no orphan keys). This split survives parallel feature development on 16 locales.

## Two byproducts: anti-i18n hardcoding rules

Outside the workflow proper, scaling to many locales also exposed two anti-i18n product rules.

**Hardcode the script-escape UI strings.** Our LocaleSwitcher on mobile has a "More" button. The first version went through an i18n key, `common.actions.more_languages`. We caught the bug later: this string is an **escape hatch**. If a user has accidentally switched into a script they can't read (a Japanese speaker into Thai, a Russian speaker into Chinese), they need an affordance to get back. Translating that affordance into a script they can't read closes the trap. Delete the key, hardcode the literal `"More"`, ship it identically in all 16 locales. The same rule generalizes: if we ever add an "I can't read this, switch language back" toast, it stays in English.

**Width-sensitive slots: fix the width, fallback by locale; don't widen the layout for locales.** The navbar login button, in an early version, expanded its capsule to fit `Iniciar sesión` / `Se connecter` / `Inloggen`. Result: the English `Login` drifted around inside a button that was now too wide for it. We reverted to a fixed `w-20` (5rem, exactly fits `ログイン`) and chose, per locale, either the localized word or `SIGN IN` as a fallback. `Войти`, `Σύνδεση`, `Accedi`, `Inloggen` all fit. `Đăng nhập` doesn't — so Vietnamese gets the `SIGN IN` fallback.

Neither rule is i18n-workflow material — they're product decisions that only become visible past a certain locale count. Worth recording alongside the workflow.

## Where this workflow works, and where it doesn't

Works when:

- The project has real multi-locale demand with brand-voice expectations, where pure machine translation + human spot check isn't sufficient (or isn't timely);
- A developer who knows English plus at least one source language (e.g. Chinese) can make final quality calls on the source / fallback locales — you don't have to commission per-locale native reviewers per key;
- The repo has parity + token-preservation tests that give agents a structured feedback loop. Spec-review has something to hold on to.

Doesn't work when:

- Translation quality has to clear marketing-copy bar — `Войти` vs. `Войдите` nuance, double meanings in ad copy. Agents beat native spot check; they don't beat a copywriter;
- There's no source-language gatekeeper. The flow amplifies source quality 16x. A bad source phrase becomes 16 bad translations;
- You want full fire-and-forget autonomy. Our Thai run was agent-autonomous, and it worked — but the prerequisite was six already-stable locales' worth of converged protocol. The first time you set this up, you're in the loop.

We're not going to package this as an "AI translation product" — its value is that the craft is tuned for a specific project shape. That's craft, not product.

## Summary

Two weeks of craft compressed into a few rules:

1. **Add new language → codex writes, Claude does spec-review, codex does cross-cutting review.**
2. **Add key → Claude writes, codex cross-reviews.**
3. **Whoever writes, the other reviews.** This rule matters more than the tool split.
4. **Parallel codex requires the four sister-locale guards.** Otherwise: silent trample.
5. **First commit of a new feature ships zh / zh-hant / en only.** Other locales land in a separate commit.
6. **Hardcode script-escape UI strings.** Don't route them through i18n keys.
7. **Width-sensitive slots: fix the width, fallback by locale.** Don't widen for long locales.

That's an operating manual for a 16-locale frontend. Behind all of it is one principle: **let two AI tools each do the part they're steadiest at, always pair them across contexts to review each other, and identify the product decisions that AI shouldn't be auto-converging on at all — hardcode those.** The rest the workflow drives itself.

If you're working on a multi-locale project with an AI agent at hand, hopefully this saves you a few rounds of trial and error.
