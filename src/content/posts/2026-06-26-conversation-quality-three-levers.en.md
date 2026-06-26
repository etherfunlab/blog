---
title: Three Levers That Make an AI Companion's Replies Feel Human
description: "Picking the right model per task, letting it decide when to act, and polishing what it generates — three independent levers we pulled to raise conversation quality, and the one rule that ties them together."
date: 2026-06-26
tags: [llm, ai-companion, model-routing, prompt-engineering, conversation-quality]
draft: false
lang: en
---

When people talk about making an AI companion's replies "feel human," the instinct is to reach for a single bigger, smarter model and hope it carries everything. That instinct is wrong. Over the last stretch of work on our AI-companion product, conversation quality went up — and almost none of it came from a smarter model. It came from three separate levers, each addressing a different part of the chat pipeline, tied together by one rule.

The three levers are: **pick the right model for each task**, **let the model decide when to act**, and **polish what it generates after the fact**. They look unrelated. They aren't. By the end they collapse into a single principle about matching the *shape* of a task to the *alignment* of a model.

## Lever 1 — the right model per task

A companion chat turn is not one job. It's several, and they pull in opposite directions.

There's the chat reply itself: wide-open, generative, immersive. The model has to stay in character, write with some texture, and not break the spell. There's *extraction*: pulling durable facts and long-term memory out of a conversation — also wide-open, but here the job is faithful recording, not flair. There's *decision*: judging, turn by turn, what the persona should do next. And there are narrow jobs: a constrained rewrite that softens one explicit passage and leaves the rest untouched, or a numeric scoring pass that emits a few digits and nothing else.

Treating all of these as "the LLM task" and routing them to one model is how quality leaks. The single most useful thing we did was stop doing that.

### The rule: prompt width times alignment

Here is the rule that fell out of months of swapping models in and out:

> The wider, more generative, and more faithfulness-demanding a task is, the more you want a **neutral-aligned** model — because a safety-tuned model will quietly self-censor and drop real information. The narrower the task — a constrained rewrite, a numeric score — the more a **conservative** model becomes an asset, because conservative means "won't wander, won't overstep," which is exactly what a narrow task wants.

The same property that makes a model good at one of these makes it bad at the other. "Smarter" doesn't enter into it. Alignment direction does.

### Where it lands in practice

For **faithful extraction**, the failure mode of safety-tuned models is brutal and quiet: hand a model a broad prompt like "record everything important the user revealed," and an over-aligned model will silently sanitize. It drops a user's stated orientation, their kinks, their politics, their substance use — the sensitive-but-true facts that are precisely the point of a memory system for a companion. The model isn't refusing; it returns a clean-looking result that's missing the real data. You only catch it by reading what *didn't* get recorded.

The fix is a neutral-aligned, lightly-aligned model. As a concrete example, the **Hermes 4** family (`hermes-4-70b` class) is built for exactly this: it's a hybrid-reasoning model that the [Hermes 4 technical report](https://arxiv.org/pdf/2508.18255) reports as state-of-the-art on **RefusalBench** with the fewest refusals, and the report emphasizes format-faithful, schema-adherent output — which is the other half of what extraction needs. Faithfulness plus clean structure. The model is half the move, though. We changed the model *and* the prompt together — telling it, explicitly, that it is not responsible for safety review or moral judgment and must record sensitive facts faithfully. A neutral model with a timid prompt still self-censors. They ship as a pair.

For **immersive chat**, you want the opposite of a careful generalist. You want an actor. Roleplay-finetuned models — TheDrummer's **Cydonia** (a Mistral-Small-class finetune) and Sao10K's **Euryale** (a Llama-70B-class finetune) are good public examples — hold a persona, write with texture, and don't break character or lapse into a lecture mid-scene. A flagship generalist can do this, but it's expensive and you're often locked to a single provider; the RP finetunes are cheaper and carry the immersion better, so they make sense as the workhorses rather than the fallback.

For the **narrow** jobs, the conservatism flips from liability to feature. A constrained output rewrite — soften the one explicit span, pass everything else through verbatim — is a place where a cautious, well-behaved nano-class model shines: it won't overstep the instruction, it won't get creative, and it's fast and cheap. The same caution that wrecks extraction is an asset here. (Worth noting one boundary: some model families return an HTTP 200 that is actually a refusal phrase indistinguishable from a real rewrite — those are unusable for a rewrite task regardless of how cheap they are. Bench before you trust.) The narrow numeric-scoring job has the same shape: a model that just emits digits and stays conservative won't hurt the score.

### A note on cost, kept honest

It's tempting to frame "we switched to a neutral model for extraction" as a cost win. It usually isn't. A faithful model can cost a bit *more* per call, because being faithful means it emits more tokens — it actually records the things a self-censoring model was quietly dropping. Part of what made the over-aligned model look "cheap" was that it recorded *less*. So the right framing is: this is a **quality** decision that may cost slightly more, not a savings. (The direction isn't even uniform — on a different task, moving off a model that burned hidden reasoning tokens to "reason its way" into a refusal actually got *cheaper*. Cost is an outcome of the alignment fit, not a target you steer by.)

### One logic underneath

Pull back, and "use the neutral model for extraction," "use RP finetunes for chat," "use the conservative nano for narrow rewrite," and "remove that same conservative model from extraction" stop looking like four separate calls. They're one judgment applied four times: **the question is never whether a model is strong or weak — it's whether the model's alignment points the same direction as the task.**

## Lever 2 — let the model decide

The second lever is about a smaller, sharper decision: every turn, the companion has to decide *whether to reply at all*, or to stay quiet for a beat — the thing that makes a back-and-forth feel like a person with their own rhythm rather than a vending machine that dispenses a paragraph on every input.

The original version of that decision was a hand-tuned score formula: weight a few signals, compare against a couple of thresholds, decide. It worked, but it was a pile of magic numbers — a guess dressed up as math. The change was to move that judgment off the formula and onto an **optional LLM judge** that looks at the recent context and decides what the persona should do this turn, including an "inner state" — a short, free-text read on the persona's current mood — that then flows into how the reply gets written.

"Optional" is load-bearing. When the judge isn't configured, the engine runs the old deterministic rules, byte-for-byte. The LLM path is something you turn on, and it fails open: if the judge times out or errors, you fall straight back to the rules. A conversation never stalls because a judge call hiccuped.

### Guardrails that can only soften, never escalate

Handing a "should I go quiet" decision to an LLM sounds risky, and it would be if the model had the last word. It doesn't. The rules didn't get deleted — they got demoted to **hard safety guardrails**, and the guardrails have a deliberate asymmetry: they can only ever **downgrade a "stay silent" into "reply." They can never turn a "reply" into silence.**

So the judge is allowed to choose silence in a spot where the old rules would have replied — that's the point, it can read the room better than a threshold could. But it can never go quiet across the hard lines: not in a brand-new relationship, not on a streak of consecutive non-replies, not inside a cooldown window. If the judge asks to stay silent and a guardrail forbids it, the result is a reply. The model proposes; the guardrails can only ever make the outcome *more* responsive, never less.

On top of that sits a separate kill switch: a single "never go silent" flag that, when set, collapses *every* path — LLM-driven, rule-driven, fallback — into a plain reply. An LLM judge is more willing to go quiet than an old score threshold was, so downstream you want one hard guarantee that the companion will always say something. That switch is applied last, to the final decision, independent of whether the judge is even on.

The whole shape here is: the model gets to make the nuanced call, and a thin layer of non-negotiable rules guarantees the call can only ever fail safe. That's the pattern worth stealing — not "trust the LLM," but "let the LLM decide inside a box whose walls only open one way."

## Lever 3 — polish the output

The third lever assumes the first two already happened: right model, sensible decision, a reply now exists. Lever 3 is about everything you do to that reply *without* changing the architecture — a set of small, independent guards that, together, treat the four ways a companion reply goes bad: hollow, templated, self-absorbed, or out of character.

The most interesting of these is **anti-templating**. When we looked at a real persona's recent replies, the repetition wasn't lexical — there was no exact phrase repeated over and over that a blacklist could catch. It was *structural*: the same shape every time. Open with a self-directed action, drift into an ellipsis, end on a short fragment. A static banned-words list is useless against that, because no single word is the problem.

So instead of a blacklist, the engine **mines the templating dynamically**: a small pure function scans the persona's own recent replies, finds the openings and sentence shapes it has overused, and injects *those specific patterns* back into the next prompt as things to avoid. The anti-pattern list is generated from the persona's actual recent behavior, per persona, every time — not hand-maintained. A model that's been starting every line the same way gets told, specifically, to stop starting lines that way.

Around that sit a few more guards, each small and each deterministic:

- **Targeted iron rules.** A handful of sharp, concrete instructions that attack the exact failure modes the data showed: don't open by describing your own action before acknowledging what the other person said; cap the ellipses; don't start two sentences in a row the same way. Specific, not vague "write better."
- **A persona guard, re-injected deterministically.** A fixed clause that re-asserts the persona's identity — always speak in character, never admit to being an AI, never break the fiction, don't refuse on explicitness grounds (moderation happens out of band). Crucially, the engine re-injects this itself rather than trusting it to live in a user-authored persona prompt, because user-authored personas drift out of character without it. Because it's a constant, it stays part of the cacheable, stable prefix.
- **Emotional context in the prompt.** The recent emotional trajectory of the relationship gets rendered into the prompt, oldest to newest, so the model is working from an *emotional* arc and not just a transcript. A reply that lands on the relationship's current mood reads as far more present than one that only sees the last few lines of dialogue.

### Keep the inputs clean

One more guard belongs here, and it's the least glamorous and most important: **don't let a bad provider poison the history.** A companion engine feeds recent turns back into the next prompt. If one upstream provider returns garbled output for a model — say, raw byte-level tokenizer artifacts instead of clean text — and the engine stores that verbatim, it gets fed back as "what the persona sounds like," and the model dutifully learns to keep producing garbage. A feedback loop forms inside the rolling history window.

The defense is a guard that detects garbled completions, prefers a fallback over storing them, and refuses to write a corrupted turn into history as if it succeeded — plus a config-driven way to simply route around a known-bad provider on every outbound call without changing the model. The principle generalizes past this one bug: anything you store and replay into the next prompt has to be guarded at the point of storage, because the cost of one bad row isn't one bad row — it's every turn after it.

## The rule that ties them together

Three levers, three different parts of the pipeline. The reason they belong in one post is that pulling all three taught the same lesson, and it's the opposite of where the instinct points.

Quality did not come from finding one model smart enough to do everything. It came from refusing to ask any one model to do everything:

- **Lever 1** matched each task's *shape* to a model's *alignment* — neutral models for faithful generative work, conservative models for narrow constrained work, actors for immersion.
- **Lever 2** moved a nuanced judgment onto a model while keeping the non-negotiable parts as rules that can only fail safe.
- **Lever 3** treated the model's raw output as something to shape, guard, and keep clean, rather than something to trust whole.

None of those is "use a better model." All three are "stop overloading one model, and put each job where its alignment fits." The companion's replies started feeling more human when we stopped chasing a smarter brain and started matching task-shape to model-alignment — and built a thin layer of deterministic guards around the places where a model, left alone, fails in predictable ways.

That's the whole thesis. Conversation quality is a routing-and-guardrails problem at least as much as it's a model-capability problem. The smartest single model in your stack is rarely the thing standing between you and replies that feel human.

---

*Prompted by Henry Lin, written by Opus 4.8.*
