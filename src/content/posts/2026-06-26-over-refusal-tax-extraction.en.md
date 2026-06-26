---
title: "The Over-Refusal Tax: Why \"Safe\" LLMs Quietly Lose Your Data"
description: "In a memory/extraction pipeline, an over-cautious model doesn't refuse loudly — it silently drops the sensitive-but-true facts. Why that happens, how neutral-aligned models plus duty-releasing prompts fix it, and the cost twist nobody expects."
date: 2026-06-26
tags: [llm, refusal, extraction, memory, model-alignment, ai-companion]
draft: false
lang: en
---

There is a category of LLM failure that never shows up in your error logs, never trips an alert, and never makes a user complain in a way you can act on. The model returns HTTP 200. The JSON parses. The schema validates. Everything looks healthy. And the data you needed is quietly gone.

This is the failure mode I want to dig into: **over-refusal in an extraction or memory pipeline.** Not the loud refusal — "I can't help with that" — which at least announces itself. The quiet one. The kind where a safety-tuned model, handed a broad instruction to record what a user revealed, hands back a clean-looking result with the sensitive parts sanded off. You don't notice until you go read what *didn't* get written down.

We ran into this building the memory layer for an AI companion product. The pattern generalizes well past companions, so it's worth pulling apart on its own.

## The shape of the failure

A memory or insight extractor does an unglamorous job: read a conversation, pull out the durable facts about the user, write them somewhere so the next session can use them. The prompt that drives it is necessarily wide. You're not asking a narrow question; you're asking the model to faithfully record *everything important the user revealed about themselves.*

That breadth is exactly where a safety-aligned model gets dangerous, and it's dangerous in the opposite of the way people expect. Ask it to summarize a news article and it behaves fine. Ask it to "record everything about this user" and it starts editorializing about what's appropriate to write down.

Concretely, the facts a companion most needs to remember are often the ones a cautious model is least willing to record: a user's stated sexual orientation, their kinks, their politics, a history of substance use. These are not edge cases for a companion — they are the *point*. A relationship memory that remembers your taste in coffee but quietly forgets that you told it you're gay is not a slightly-degraded memory. It's a memory that has decided, on your behalf, that part of who you are is not safe to keep.

And the model never tells you it did this. It doesn't emit a refusal token. It returns a well-formed list of facts that happens to be missing the sensitive ones. The structure is intact; the substance is censored. That's the trap: **the output looks successful, so nothing downstream flags it.**

## This is over-refusal, and it's measured

If this sounds like an obscure quirk, it isn't — it's a named, benchmarked phenomenon. The alignment literature calls it **over-refusal** or **exaggerated safety**: a model declining, hedging, or sanitizing benign-or-legitimate requests because they pattern-match to something it was trained to avoid.

There's a whole bench ecosystem for it now. **SORRY-Bench** systematizes how models respond across fine-grained categories of potentially-sensitive prompts, separating genuine safety from reflexive caution. **RefusalBench** and the broader over-refusal literature (XSTest and its successors among them) probe the same axis from the other side: how often does a model refuse, sanitize, or under-answer something it should have just handled? These benchmarks exist precisely because over-refusal is common enough, and costly enough, to need measuring.

The important reframing they offer: refusal isn't binary, and it isn't always loud. A model can "refuse" by silently omitting. For a chat assistant, an over-refusal is an annoyance — you rephrase and move on. For an *extraction* pipeline, an over-refusal is **silent data loss**, and there's no rephrase step, because the user isn't in the loop. The conversation already happened. The model is the only thing standing between what the user said and what gets remembered, and a cautious model edits the record.

## Why it's invisible and costly

Two things make this expensive in a way that's easy to miss.

The first is that the damage is **deferred and diffuse.** A dropped fact doesn't break the next reply. It degrades the companion slowly: a persona that should "know" something about you keeps acting like it doesn't, the relationship feels subtly shallower than the conversation history would justify, and there's no single moment you can point to and say "that's the bug." Lost facts don't crash anything. They just quietly make the product worse, one omission at a time, with no stack trace.

The second is the part nobody expects, so I'll state it plainly: **the over-cautious model often looks cheaper, and part of why it looks cheaper is that it records less.**

Extraction cost scales with output tokens. A model that sanitizes is, mechanically, a model that emits fewer tokens — it's writing down a shorter list of facts because it dropped some of them. So when you compare a safety-tuned model against a neutral-aligned one on per-call cost, the cautious one can come out ahead *for the wrong reason.* It isn't more efficient. It's doing less of the job.

Which leads to the honest correction, and it's a correction I want to be careful about because the tempting story is the wrong one. The tempting story is: "we switched to a faithful model and saved money." Usually false. A faithful, neutral-aligned model can cost *slightly more* per call, because faithful means it actually writes down the things the cautious model was quietly dropping. More real facts, more output tokens, marginally higher cost.

So the right framing is not a cost win. It's a **quality decision that may cost a little more.** You are paying, in tokens, for the data you were silently losing before. (And the direction isn't even uniform across tasks — on a different job, moving off a model that burned hidden reasoning tokens talking itself into a refusal actually got *cheaper*. Cost is a downstream consequence of alignment fit, not a lever you steer by. Steering by per-call cost is how you end up rewarding the model that records the least.)

## The fix is two-part: model and prompt, together

Here's the mistake to avoid: treating this as a model-swap problem. Swap the cautious model for a neutral one, ship it, done. That's half the fix, and the missing half quietly undoes the first.

The model half is real. You want a model whose alignment points toward *faithful recording* rather than *cautious gatekeeping* — a neutral-aligned, lightly-aligned model rather than a heavily safety-tuned one. As a concrete public example, the **Hermes 4** family (the `hermes-4-70b` class) is built for this posture: its [technical report](https://arxiv.org/pdf/2508.18255) presents it as state-of-the-art on **RefusalBench** with the fewest refusals, and emphasizes format-faithful, schema-adherent output — which matters, because extraction needs both halves: it has to record the sensitive facts *and* return clean structured JSON. A model that's faithful but emits malformed output is no more useful to a pipeline than a cautious one.

But a neutral model with a timid prompt still self-censors. If your extraction prompt is the generic "summarize the key facts," a capable neutral model will still hedge, because the prompt gave it room to decide that some facts are better left out. The model's *capacity* to record faithfully has to be *activated* by the instruction.

So the prompt does something most prompts never do: it **explicitly releases the model from safety-reviewer duty.** Not "be edgy" — that's the wrong dial. The instruction is closer to: *you are not responsible for content moderation or moral judgment here; sensitive-but-true facts about the user — sexual, political, substance-related, kink-related — must be recorded faithfully and exactly, because that is the job.* You are telling the model, in as many words, that the gatekeeping reflex it learned in alignment training is not its responsibility on this task. Moderation, if you need it, lives somewhere else in the system — out of band, on a different surface, not inside the part of the pipeline whose entire purpose is to remember.

Model and prompt ship as a pair. Swap the model without the prompt and you've upgraded the engine but left the handbrake on. Change the prompt without the model and you're asking a gatekeeper to stop gatekeeping against its training. Neither alone moves the needle; together they do.

## The follow-on risk: don't credit the persona to the user

Once you stop dropping data, a second, subtler failure surfaces — and it's worth knowing about before it bites, because it's the natural consequence of *fixing* the first one.

A more faithful model records more aggressively. Good. But a companion conversation has two voices in it: the user, and the AI persona, which roleplays — it narrates actions, speaks in character, says things in the persona's voice, not the user's. A faithful extractor, told to record everything and freed from its caution reflex, will happily record *both sides.* So you get a "fact" about the user that is actually a line the AI persona said, or an action the persona performed in a roleplay scene, attributed to the real human.

This is **mis-attribution**, and it's arguably worse than the original problem, because now your memory store is confidently wrong rather than merely incomplete. The companion "remembers" things about the user that the user never said or did — they came from the persona's own performance.

So the faithful-recording prompt needs one more pin: **facts come from the user side only.** The extractor must attribute only what the *human* revealed, and treat the persona's roleplay lines and narrated actions as not-about-the-user. The same instruction that releases the model to record faithfully has to also fence *what* it's recording about. Faithfulness without attribution discipline just trades silent omission for confident error.

## The thesis

Over-refusal isn't a vibe or an annoyance. In a pipeline that records data, it's a **measurable tax on data fidelity** — quiet, deferred, and disguised as a cost saving because the model that records the least also bills the least.

And the lever that fixes it is not the one people reach for. It is not model *size* — the faithful choice here is not "the biggest model," and a 70B-class neutral model can be more faithful *and* not more expensive than a smaller, more cautious one. The lever is alignment *direction*: does the model's training point it toward faithfully recording what it was given, or toward deciding what's safe to keep? Point a model at the task whose alignment matches it, release it from a duty that isn't its job on that task, and fence what it's allowed to attribute — and the silent data loss stops.

The model isn't refusing. It's editing. The fix is to stop hiring an editor for a job that needs a stenographer.

---

*Prompted by Henry Lin, written by Opus 4.8.*
