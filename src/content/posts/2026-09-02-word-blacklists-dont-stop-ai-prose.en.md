---
title: "Word Blacklists Don't Stop AI Prose"
description: "The stubborn part of AI writing isn't vocabulary. It's the empty slot a syntactic frame leaves behind, and judging whether that slot was filled honestly needs a fact from outside the sentence — which is why the rule has to bite at drafting, not at editing."
date: 2026-09-02
tags: [ai-writing, llm, writing-workflow, prose, rlhf, editing]
draft: true
lang: en
---

The standard way to strip AI flavour from a draft is a banned-word list. Delve, tapestry, underscore, leverage. See one, swap it out.

The list works. We maintain four of them. It also cannot touch the most conspicuous thing models do.

What it cannot touch has one useful property: **it is not a ceiling on what the model can produce.** The same weights write clean prose in another setting, with no prohibitions in force at all. The difference is how much constraint that setting supplies.

So this piece covers three things: what the list misses, the conditions under which a model stops doing it unprompted, and which stage of an editing pipeline can actually enforce the rule.

One disclosure up front. **A model drafted this article, under the rules the article describes.** One sentence in that draft was deleted for breaking them. The deletion is at the end.

## Two symptoms, two causes

"AI flavour" is a bag holding two different problems. They have different origins, and the tools that catch one do nothing to the other. Treating them as one problem produces advice that contradicts itself.

| Symptom | Example | Where it comes from | Does a word list catch it? |
|---|---|---|---|
| **Jargon** | delve, tapestry, synergy; in Chinese 赋能, 抓手, 颗粒度 | **A polluted corpus.** The words were already everywhere in the training text | **Yes** |
| **A syntactic frame** | "It's not X, it's Y" and its family | **Post-alignment training** | **No** |

A word list is the right tool for row one. Row two is what it cannot reach. The jargon line comes back later; the frame line comes first.

## The most stubborn frame

"It's not X, it's Y." Also "not just X, but Y."

It has a formal name. Wikipedia's [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) gives it a section as **negative parallelism**:

> It is common for LLMs to use parallel constructions involving "not", "but", or "however" such as "Not only ... but ..." or "It is not just ..., it's ...".

The same page treats the rule of three, three parallel items in a row, as a separate marker.

There is one public count. The Washington Post analysed **328,744** publicly shared English ChatGPT messages, drawn from 37,929 conversations, restricted to `gpt-4o` and to messages of at least ten words, spanning May 2024 through the end of July 2025. From that analysis:

> ChatGPT frequently uses versions of the phrase "not just X, but Y," which appeared in 6 percent of chats in July.

**The denominator there is conversations, not messages.** The corpus is counted in messages; the 6 percent is not.

The Atlantic has written about the frame as the most recognisable marker of machine text, and its position is that **nobody knows why it happens**, possibly including the companies that build the models. Laurentia Romaniuk, a product manager for model behaviour at OpenAI, calls it **contrastive phrasing**, and says the company is working to widen the model's range.

## Where it comes from

The documented part is that alignment compresses output diversity:

- **Kirk et al.**, [arXiv:2310.06452](https://arxiv.org/abs/2310.06452) (ICLR 2024): "RLHF significantly reduces output diversity."
- **Zhang et al.**, [arXiv:2510.01171](https://arxiv.org/abs/2510.01171) (ICML 2026), which brings mode collapse over to language models and attributes it mainly to a **typicality bias** in preference data.

Two pieces of common phrasing are worth correcting against those papers. A mode is the most typical, highest-probability output, so "the model gets pushed toward the average" describes the wrong statistic. And the driver is post-alignment training as a whole rather than the reward function by itself.

Why this particular frame gets reinforced has no settled answer. The closest available account is that human reviewers scored responses using the construction highly, because it "gives the impression of nuance and insight". That appears in Wikipedia's entry and on one aggregator, with the wording differing between them, and the Atlantic piece itself sits behind a paywall, so treat it as reported rather than quoted. Beyond that, two elaborations circulate, both speculative: that rejected responses skew short and flat while chosen ones skew expansive, teaching the model to name the simpler reading before discarding it; and that contrastive structure occupies high-entropy states useful for extending a reasoning trace. The author of the second uses the words "I suspect" and cites no data.

A thread on Hacker News discussing the frame produced no mechanism either, but it did produce a caution worth keeping: some human writers use antithesis heavily by preference. One commenter, writing from the autism spectrum, reported that prose they wrote in 2010 now gets flagged as machine-generated. The frame is a prior, not evidence.

## Nobody discusses this part: it disappears in agent turns

All of the above concerns a model writing prose. The same model, running as an agent — calling tools, editing code, reading logs — almost never produces the frame.

I have not found published analysis of that gap. What follows is my own reading.

1. **The habit attaches to the "explain this to a person" conditional, not to the weights.** An agent turn is conditioned on tool schemas, code, and a task with a verifiable end state. Prose is conditioned on published expository writing, where these frames are genuinely common.
2. **The preference pairs that taught expansiveness over flatness were collected on chat answers.** Tool-calling turns are graded mostly on whether the command worked, so that gradient barely touches this register.
3. **Rhetoric produces length.** An article has no "tests pass" to stop at, so the model needs internal reasons to keep emitting tokens.
4. **Prose has no prosody.** Speech marks emphasis with stress. Writing has to reach for syntax.
5. **In conversation the antecedent is real.** The X in "not X" is what the other person just said. Writing alone, there is no other person, and the frame still demands an X, so the model invents one.

## The empty slot

Generalise the fifth point and you have the foundation for everything below.

A model writing prose carries a set of productive syntactic frames: contrast, parallelism, the three-part list, signpost phrases, inflated nouns. **Every one of them leaves a slot that has to be filled.** With real material when there is some, and with something when there is not.

What comes out of an unfilled slot reads like information and carries none:

- The straw man had no author. Nobody held the reading being denied.
- The signpost connects nothing. What follows "It is worth noting that" was not more notable than the sentence before it.
- The inflated noun refers to nothing. Swap it for a plain word and no meaning moves.

Three products of the same mechanism. What the rules have to block is the slot that can be filled without material.

## Models can write prose without the tells

The sections above read as a pessimistic conclusion: an ingrained habit, catchable only downstream.

The situation is better than that. **The same model, the same weights, writes cleanly when the constraints are sufficient.**

The direct evidence is the observation above. The frame nearly vanishes in agent turns. Nobody tuned it away, and no tool-use system prompt bans contrastive phrasing. It vanishes because that context **leaves no empty slots**: the task has a verifiable end state, the material is code and logs, and every sentence has a corresponding fact to state.

So this is a constraint problem. Which makes it worth being precise about what counts as a constraint, because the most common kind does nothing.

**Constraints that fail**: "write more naturally", "avoid AI flavour", "sound human". None of these supplies material or a test. The model faces the same slots and is asked to fill them less visibly. Usually the vocabulary changes and the frames survive.

**Constraints that work, in order of effect:**

1. **Supply material.** A slot gets filled with invention because there was nothing true to put in it. Most of the instances in our own document library pass review, and the reason is density rather than restraint: those documents have a real source behind every claim. This one is preparation, not a writing technique.
2. **Supply a test the model can apply.** "Do not build straw men" is not testable. "Can you name where this reading came from" is.
3. **Put the test at the stage that can run it.** Covered below.

Together they explain why removing AI flavour cannot be delegated wholesale to a final editing pass. That pass holds neither the material nor the sources. It can only work at the level of words, which is the shallowest layer the problem has.

## Back to jargon: why a word list does work there

Jargon is not something models invented. The words were already dense in the training corpus.

The Chinese case is well documented, and it is worth walking through because the shape generalises. Corporate vocabulary spread from big-tech companies through HR and the press, marketing accounts copied it at volume, and models learned it as it stood. A public timeline exists: a widely covered March 2021 anniversary speech in which a founder read internal jargon aloud on stage, press coverage the following month that turned "tech companies don't speak plainly" into a public topic, and a 2023 comedy film that pushed the phrase 对齐颗粒度 into general circulation.

The etymologies differ sharply in how well they are attested:

| Word | What is documented |
|---|---|
| **赋能** | Corresponds to *empowerment*, from management theory, traceable to Follett in the 1920s. Solid. |
| **颗粒度** | Appears in Chinese national standard GB/T 10558-**1989**, on measuring root-mean-square photographic granularity. The computing register uses 粒度 instead. No link to management consulting, and the split between the two forms is unstudied. |
| **对齐** | The Strategic Alignment Model (Henderson and Venkatraman, 1993) did appear in *IBM Systems Journal* 32(1), but the usual Chinese rendering is 战略一致性, so that transmission path breaks. The workplace sense is most likely a direct translation of spoken "align" — a folk account, with no corpus-level study behind it. |

Two of these need splitting by sense. 对齐 as ML alignment and 闭环 as a control-theory closed loop are defined terms and stay protected; 对齐一下 and 形成商业闭环 in a meeting are jargon and go. The test does not change: does the word refer to anything here?

**The conclusion for this line: the word cannot be rescued.**

Our conventions ban 颗粒度 outright. The reason is not a defect in the word. Usage in the Chinese corpus is polluted deeply enough that even its original sense is not worth reaching for; unit, level, precision, or split criterion each say the intended thing more exactly. **At this layer a word list is entirely sufficient**, because the test sits on the surface of the sentence: does this word refer to anything here? If not, cut it.

## How far down a list reaches

Now the boundary is easy to state.

"It is worth noting that" is a signpost. Deleting it loses nothing, and **the judgement can be made from the sentence alone**. A list catches it. The inflated noun works the same way.

"It's not X, it's Y" does not work that way. Whether it is legitimate depends on whether X exists, and **whether X exists is not in the sentence**.

One frame, two situations:

- "This was hand-tested, not measured." — X is the stronger claim a reader would otherwise assume. Denying it carries information.
- "These four steps are not a database requirement, they are a rolling-upgrade requirement." — I wrote that one, and I cannot name anyone who ever held the first half.

Identical syntax. The difference sits outside the sentence.

## The test

So the rule reduces to one question: **can you name where this reading of X came from?**

The source has to be specific. A review comment, a judgement an earlier document actually made, a conclusion from another piece, a false impression the data itself invites. **You have to be able to name the source at the moment you write X.** If you cannot, that reading has one holder, the author, and the sentence goes.

Five cases pass:

| Case | What it does |
|---|---|
| Correcting a misreading | The default reading leads a reader to a false conclusion |
| Classifying to decide handling | X and Y are real categories and the category determines what happens next |
| Marking evidence strength | The thing denied is the stronger claim the reader would assume |
| Separating two confusable objects | X and Y both exist and are routinely conflated |
| Overturning your own earlier judgement | X is documented and readers may still hold it |

Quotations keep the construction as written. Their X has a speaker, so the test passes by definition.

One class of rule needs care. **A surface-level condition such as "X may not be a vague abstract noun" costs nothing to add, and it will impersonate the real test.** Someone runs it as a checklist, swaps in a concrete noun, and ships a reading nobody ever held.

## Which stage owns which rule

Push that through and you get the transferable result:

> **A rule belongs to whichever stage holds the fact needed to judge it.**

| The fact needed to judge it | Who enforces it |
|---|---|
| Character level: punctuation, formatting, schema | A script, unread by humans |
| Present in the sentence: inflated nouns, signposts, tone | The editing pass |
| **Outside the sentence**: provenance of X, whether a number is inflated, whether something shipped or is planned | **Do not write it at drafting**; the editing pass flags without changing |

The third row is the one that matters. **An editing pass holds only the sentence.** Force it to act and both outcomes are worse than leaving the text alone: the straw man survives in different words, or a distinction that was carrying weight gets deleted.

So our editing stage marks these and changes nothing, and the decision goes to the stage that can check sources. For any new writing rule: ask what fact is needed to judge it, then decide whose checklist it belongs on.

## Deletion rules overshoot

One more category, whose entire purpose is to stop the rules above from being over-applied. We collected three the hard way:

| Counter-rule | The over-application it blocks |
|---|---|
| A protected-terminology list (idempotent, monotonic, orthogonal, closed loop) | "No jargon" gets executed as "replace technical terms with plain speech" |
| An exemption for the Chinese em dash | An editing pass told "never use an en dash" flattens every 「——」 in the file |
| Keep the roadmap and the vision | "Don't pad" gets executed as "delete everything forward-looking" |

The shape is shared: **a rule written to remove things, handed to a model, overshoots toward removal.** So every deletion rule needs its exemption written next to it, worked out at the same time.

## Measured

Scanning our own technical document library for this frame, counted in matching lines: 370 before the rule landed, 387 after the two documents written the day it did. The number grows as we write, so any recount has to name the commit it scanned.

The counterintuitive part: **most of them pass the test.** Their X side has a real source — dirty data from a retired model, a judgement an earlier document stated outright, a reading trap flagged in an audit report. So the rule was never turned loose on the archive. It operates at drafting only.

A long piece written the day the rule landed hit 10 instances. Seven survived the test; three were cut. The survivors trace to specific files, commits and pull request numbers. The three cuts were straw men the author built, one of them to open a section: the frame left a slot, and the author filled it with a reading nobody held.

## Standing on

Two open-source skills do the editing work here, both MIT:

- **[blader/humanizer](https://github.com/blader/humanizer)** by Siqi Chen, used on English drafts. It is a checklist of 35 patterns drawn from Wikipedia's [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), credited in its README. The first half of this article started from it.
- **[KKKKhazix/human-writing](https://github.com/KKKKhazix/human-writing)**, used on Chinese drafts. An independent Chinese skill rather than a translation of the first.

A well-made Chinese-language entry point to the topic is the Bilibili video [《为什么 AI 写的东西一眼就能看出来？我做了个去AI味技能》](https://www.bilibili.com/video/BV1uQ8E6LE6G/) (2026-08-19). Its author gave twelve models the same brief, an explainer on the TCP three-way handshake, and counted: ten of twelve openings converged, 302 three-part constructions in total, up to 22 em dashes in a single piece, with "不是 A 而是 B" ranked worst.

Two caveats. Those are the author's own measurements rather than third-party research, Also, the four-layer "humanizer" demonstrated in it is a skill he generates live from a prompt during the video, and **shares only a name with blader/humanizer**.

## This article's own score

The Chinese edition can be scanned with one regular expression, which returns 15 matching lines: seven name or quote the construction, eight are real uses, one was cut. English resists that. The family spreads across "not X, but Y", "rather than", "X, not Y" and half a dozen other surfaces, and no single pattern catches them without also catching ordinary negation, so this count is a manual pass rather than a script.

By hand, this article uses the construction about a dozen times. Roughly half of those name or quote it, including both example sentences above; mention is not use. The rest are real uses with a source I can name, the clearest being "the denominator is conversations, not messages" — that misreading has a source, since the corpus is reported in messages while the 6 percent is not.

**One was deleted**: "it is a drafting gate, not a cleanup tool." The first clause had already finished the sentence, so the negative half carried nothing.

That the English count is approximate and the Chinese one exact is itself worth noticing. A rule enforceable by script in one language may only be enforceable by a reader in another.

One further rule of ours got in the way. Naming the en dash character requires printing it, and the conventions forbid it in body text. The Chinese edition writes the code point instead.

That residue is the point made at the top: **give a model enough constraint and it writes prose without the tells.** Not zero instances, but every instance accountable.

The sentence above is itself a use, and it passes: its X, "then it should be zero", is what a reader would expect after the sentence before it. The rule was never that the frame should disappear. It is that every appearance should have someone who can say where the X came from.

---

*Prompted by Henry Lin, written by Opus 5.*
