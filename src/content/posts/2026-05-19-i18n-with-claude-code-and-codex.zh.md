---
title: 从 3 个 locale 扩到 16 个：Claude Code + Codex 双 AI 配合下的 i18n 翻译工作流
description: 两周内把一个 Nuxt 4 项目从 3 locale 扩到 16 locale。这篇博客讲落到工艺上的具体决策：在哪一步用 Claude Code、哪一步用 Codex CLI、为什么不能混用、并行 codex 静默踩对方目录怎么扛回来，以及一条贯穿所有翻译流程的底层规则——「写谁审谁，永远是另一个」。
date: 2026-05-19
tags: [i18n, nuxt, vue, claude-code, codex, agent-workflow]
draft: false
lang: zh
---

我们的一个 Nuxt 4 前端项目（Eros Chat，AI 陪伴产品的开放注册端）在最近两周里把 locale 数量从 3 个扩到了 16 个。

更具体地说：从 `zh / zh-hant / en` 三个 locale 开始，先后落地了 `ja, ko, de, es, fr, ru, pt-br, pt, vi, el, th, it, nl`。每个 locale 在前端的承载面是大约 14 个 surface JSON（landing / chat / account / web3 / seo / …），相加是 200+ 份 JSON 文件、外加 cities 数据、外加 navbar / LocaleSwitcher / 字体等多个 UI 横截面。

工作量本身不算意外。值得写下来的不是「翻了多少行」，而是工艺：怎么把第一轮的临时方案、第二轮的踩坑、第三轮的反向修正，逐步收敛成可以无脑套用的两类规则——加语言 / 加 key。整个流程里 Claude Code 和 Codex CLI 各承担一部分，分工不是看「谁更聪明」，而是看每一步的工作形态匹配谁。

## 工具分工的底层逻辑

Claude Code 和 Codex CLI 是两个长得有点像的工具：都是终端里的 AI coding agent，都能读 / 写 / 跑命令。但在 i18n 这个场景下，它们的工作形态差异在三件事上特别明显：

- **CLI 启动开销**：codex 每次 `codex exec` 都是新进程，要起 sandbox / 读 repo / 拉 context；我们实测启动开销 1–2 秒。Claude Code 是同一个长 session 里持续推进，每次编辑不再付这段进程启动。
- **写入域**：`codex exec -s workspace-write` 把它的**工作根目录**设为可写——而我们的用法里这个根目录就是整个 repo，目标 locale 只在 prompt 里钉死。所以「只动 `i18n/locales/X/`」是一条建议性指令，不是 sandbox 边界——这是后面 race condition 的根源。Claude Code 的工具调用走主 session，文件改动可见、可追溯。
- **批量 vs 微操**：codex 适合「一次开 prompt、一次跑完约 14 个文件」的批量任务；Claude Code 适合「在多个文件上做小修小补、跑测试、调整、再跑测试」的连续微操。

落到 i18n 工作流上，最有用的一条经验法则是：

> **单次任务规模 × 是否需要测试反馈循环 ≈ 选哪个工具**。规模大、单趟跑完 → codex；规模小、需要测试驱动 / 连续修补 → Claude Code。

但还有一条更重要、贯穿所有翻译流程的元规则，我们写在最后再说。先看具体两类工作流。

## 加新语言：codex 写、Claude 审、codex 再扫

加新语言时，目标 locale 完全是空的，要从 0 填到 14 个 JSON。这是典型的「一次开 prompt、一次跑完」的批量任务，codex 当主写手最划算。但 codex 单跑的成品有两类问题：

1. **格式问题**：vue-i18n 的 token（`{name}`、`{count}`）有时会被「翻译」成本地化写法，或者 token 周围的空格被处理掉；这在英文里看不出问题，但在 Thai 等没有词间空格的语言里完全是另一个故事。
2. **register 漂移**：日韩特别明显——codex 可能在「丁宁体」「常体」之间漂移；俄语 informal / formal 也容易混。

所以一个 locale 的首翻是三段式：

```text
1. codex exec 跑首翻（一次性翻 14 个 JSON）
2. Claude 子代理做 spec-review：
   - key parity（跟 en 比对，零漏 key）
   - token preservation（{name} 类 token 字节级保留，包括前后空格）
   - register / orthography（per-locale 规则，比如 Thai 零 ครับ/ค่ะ）
   - brand 术语 verbatim（Eros³、Web3、NFT、SOL、Affinity Mechanism 等）
3. codex 再做 cross-cutting review：横扫跨 surface 的钝感 calque
   （「翻完了但不像母语」、整段是字面直译）
4. 主代理 apply 修复，commit 落地
```

第 3 步特别值钱。第 2 步是按 spec 查规则、Claude 很擅长；第 3 步是「跨 surface 看整体感」——同一个 brand 短语在不同 JSON 里字面化程度不齐、整段直译但单看每个词都对、register 一致但跟该语言用户实际产品的语言习惯有距离。这种东西要换一个完全不同的 context 才看得出来，codex 用新 session 跑刚好。

这三段式跑了 6 个 locale 之后基本稳定，几乎没意外了。中间有一次例外，是 Thai 的首翻——我们让整条三段式由 agent 自主跑完没有人工介入。结果第 3 步 cross-cutting review 提了 11 个候选：5 个高置信度修复（包括 `และ` 前空格的泰文 spacing 规则、Latin 名字 + 泰文 fusion 的防御重排）被合入，6 个纯审美建议被 deferred，1 个语义改写（把 "Texture" 翻成另一个完全不同的词）被显式拒绝。这是「单语场景下三段式不依赖姐妹语言对照仍然能收敛」的一次比较干净的验证。

## 反过来：加 key 时 Claude 写、codex 审

如果一个新 feature 加了一些新 i18n key，需要把这些 key 翻到 16 个 locale 里——这个工作形态跟加新语言完全相反：

- 每个 locale 只动几个 key（小 fan-out × 大 locale 数）；
- 不是一次大 prompt 跑完，是要在十几个目录里各塞几个字符串；
- 起一次 codex 的开销不被几行翻译摊薄。

我们一开始的假设是「加 key 直接让 Claude 来就行」——Claude 在 session 里展开 13 个目录、各写几行，一气呵成。跑过两次之后发现错了。Claude 单跑 13 locale 的 add-key pass 会稳定漏掉两类问题：

- **register 漂移**：俄语 informal / formal 偶发不一致，欧葡 / 巴葡动词变位串味，德语 du / Sie 偶发漂；
- **calque（呆板直译）**：同一个 brand 短语在不同 locale 字面化程度不齐——单 locale 看不出，13 locale 并排比对才显现。

为什么 Claude 单跑漏？因为它在**每个 locale 内部 self-consistent**——那行话从语法上、词汇上都没错。问题只在 13 locale 横扫 + 对照该 locale 已有 key 的 register 时浮出来。

修正后的 add-key 流程：

```text
1. 人写 zh 作为 ground truth
2. Claude 写 en、codex 写 zh-hant（这两个并行，互不踩，并各自吃自己的强项）
3. Claude 一次性顺序翻完其余 13 locale（小 fan-out 不分发 subagent）
4. codex cross-review 未提交 diff
5. Claude 应用 codex 的 NEEDS_CHANGES（通常 2–5 条），其余建议 commit log 留痕即可
6. 单 commit 合入
```

第 2 步的 Claude 写 en、codex 写 zh-hant 是个小巧但很有用的并行：Claude 写英文的语感比 codex 稳；codex 写繁体中文（包括字形选用、辞汇香港 / 台湾区别）的成品比 Claude 干净。这两个写完后，剩下 13 locale 几乎全部以 en 为 source（仅 ja / ko 走 zh 派生），所以 Claude 写完 en 之后顺势继续写其余 13 locale，整条链路 context 是连贯的。

到第 4 步把 codex 拉回来做一次横扫——这一拉就是上面说过的「同样的工作 + 新 session 看整体感」。

## 一条贯穿两套工作流的元规则

如果把上面两条流程并起来看：

| 工作形态 | 写 | 审 |
|---|---|---|
| 加新语言（批量首翻） | codex | Claude（spec）+ codex（cross-cutting） |
| 加 key（小 fan-out） | Claude | codex（cross-review） |

**写谁审谁，永远是另一个。** 这条规则比工具分工本身重要。

理由很物理：审稿要么是按显式 spec 查规则、要么是用新 context 看整体感。让同一个 agent 既写又审，它会带着自己的写法假设回头查自己——「按 spec 查」勉强还行，「换 context 看整体感」就完全没了。只有让另一个 agent 用完全独立的 context 进来，才能产生「这段为什么这样写、是不是应该那样写」的反向压力。

这条规则也适用于翻译以外的场景。我们的 Nuxt + Supabase auth 改造里（[之前的博客](/posts/2026-05-13-nuxt-supabase-ssr-cookies)）也是同样的安排：Claude Code 主驾，关键决策点 codex 二审；codex 不看主驾的结论，从零起跳。

所以与其说我们在用 Claude Code + Codex 的「双 AI 工作流」，不如说我们在用「写 - 审分离 + 跨 context 二审」这件事的两个具体实例。i18n 翻译只是把这件事压得特别紧凑而已。

## 并行 codex 的静默 race：4 条强制 mitigation

加新语言这一步可以并行——比如同一个 PR 里同时落 pt-br + pt 两个 Portuguese 变体——很自然的想法是开两个 codex 各翻一个目录。

不要默认这样做。

我们最早一次尝试是把 pt-br 和 pt 分别交给两个并行的 `codex exec`。两边的 stdout 都显示「成功翻译完 N 个文件」、退出码 0、没有 error；但是 pt 那一支 commit 时 `git diff` 工作树是空的——文件确实在某一刻被写出来过，但在并行过程中被静默覆盖或丢弃了。

根因：`codex exec -s workspace-write` 允许 codex 写它工作根目录下的任何文件，而我们的工作根目录就是整个 repo——所以 "do not touch outside i18n/locales/X/" 是 prompt 提示，不是 sandbox 边界。两路并行时，B agent 可以读、partial 写、覆盖或丢弃 A agent 已经写到磁盘但还没 commit 的产物——退出码 0、stdout 显示完成、没有 conflict。

后来我们把规约硬化成 4 条强制 mitigation，每次 dispatch 2+ 个并行 codex translator 时，每个 translator subagent 的 prompt 必须包含：

1. **Sister locales are sacred**：显式按路径列出其他正在跑的 locale 目录，明确写「do NOT touch `i18n/locales/<other>/`」。
2. **Pre/Post sister-stat 比对**：subagent 在调 codex 之前抓 `git diff --stat i18n/locales/<sister>/`，调完再抓一次，`diff` 两份；任何变更 = HARD FAILURE，立即 abort、不要 commit。
3. **自查文件计数**：subagent 报告自己 locale 目录下 modified 文件数，要求等于 N（surface JSON 总数）。codex 偶发 silent partial output（觉得自己翻完了但只写了部分文件），靠这个抓。
4. **被踩了串行重跑**：主代理检测到 sister-trample 后，把被踩的 locale 重新串行投递、不并行，重跑时仍带 sacred-sister guard。

第一次按这套规约跑的是 it / nl 两个 Latin locale 的并行首翻。两路 codex 在 disjoint file set 上各自跑完、自查通过、no trample、主代理单 commit 合入——pt-br/pt 的故障没有复现。

更彻底的硬隔离做法是给每个 codex writer 起独立的 `git worktree`、各自从 main 拉。但 4 条软规约 + agent 自检在当前 throughput 下够用，我们没急着上 worktree。

## Phase-1 cadence：首 commit 只填三个 locale

加完语言、翻译工艺也稳定之后，还有一个被忽视的工艺问题：**新 feature 的 PR 怎么和 i18n 翻译节奏配合？**

我们一开始的本能是：新 feature 加了新 key，那就把 16 个 locale 全部翻完再 merge。后来发现这个想法在两个维度上都不划算：

1. **review 心智成本**：一个新 feature PR 同时改 component / route / store / test + 16 个 locale 的 JSON，diff 会被翻译淹没，code review 看不到代码本身改了什么。
2. **代码反复改 → 翻译反复重做**：feature 在 review 阶段可能还要小幅调整文案。每改一次中文，就要追着把 16 个 locale 重翻一次——非常浪费 codex / Claude billing 周期。

修正后的节奏是：

> 新 feature 的**首 commit 只填 zh + zh-hant + en**。其余 13 locale 用脚本族感知的 placeholder 占位。等代码定稿、review 通过之后，**翻译作为同分支的一个独立 commit 一次性补完**，再 merge。

placeholder 选什么很关键，决定了 PR review / preview 部署期间页面看起来是否能用：

- **CJK fallback（ja, ko）← 拷 zh**。Latin 占位混在日韩页面里 line-height / 字重 / reading flow 都炸；zh 的汉字至少 script family 是对的，肉眼不刺。
- **Latin / Cyrillic / Greek fallback ← 拷 en**。脚本族一致，line-height / reading flow 不炸。**Thai 也拷 en**——不是因为脚本族相同（泰文不是拉丁字族），而是运行时 `fallbackLocale: 'en'` 看到的本来也就是 en，所见即所得。

parity 测试相应分层：zh / zh-hant 跟 en 做 strict key 集等价校验，其余 locale 跟 en 做 subset 校验（允许缺，但不允许多）。这套规则在 16 locale 的并发开发节奏下扛得住。

## 两条副产物：反 i18n 的硬编码规则

工作流之外，多 locale 还 expose 出两条带反 i18n 味道的产品规则。

**Script 逃生门 UI 文案硬编码英文。** 我们的 LocaleSwitcher 在手机端有一个 "More" 按钮，第一版走的是 i18n key `common.actions.more_languages`。三天后才想清楚：这个文案的作用是逃生门——如果用户误点切到自己读不懂的脚本（ja 用户切到 th、ru 用户切到 zh），他需要一个 affordance 把语言切回去；而那个 affordance 本身被翻成他读不懂的语言，就彻底死循环。删 i18n key、硬编码 `"More"`，全 16 locale 一致。同类规则：未来如果加 "I can't read this, switch back" toast，也应该硬编码英文，不是 i18n key。

**宽度敏感槽位用固定宽度 + per-locale fallback，不要为了适配 locale 拉宽布局。** Navbar 的 login 按钮一开始为了适配 `Iniciar sesión` / `Se connecter` / `Inloggen` 这类长词，把整个按钮 capsule 拉宽——结果英文 `Login` 在按钮里左右游离非常难看。改回固定 `w-20`（5rem，刚好够 `ログイン`），每个 locale 选自己的本地化 login 短语，放得下放下、放不下退化成更短的 `SIGN IN` fallback。`Войти`、`Σύνδεση`、`Accedi`、`Inloggen` 都在范围内；`Đăng nhập` 不在，所以 vi 退化到 SIGN IN。

这两条规则都不在 i18n 工作流本身里，但都是「locale 数量到一定规模之后才被 expose 出来」的产品决策——所以一并记在这。

## 这套工作流的边界

适合什么场景：

- 一个有真实多 locale 需求的前端项目，翻译有 brand voice 要求，机器翻译 + 人工校对不够（或不及时）；
- 开发者懂英文 + 至少一种 source 语言（比如中文），能对 source / fallback locale 做最终质量决策，不需要逐 locale 找母语 reviewer；
- 项目里有 parity test + token preservation test，让 agent 翻译时有结构化反馈循环——agent 跑 spec-review 就有抓手。

不适合什么场景：

- 翻译质量要求高到「营销文案级」——`Войти` 跟 `Войдите` 的区别、广告语里的双关，agent 翻得过 native 校对，但过不了广告 copywriter；
- 没有 source-language 把关者——这套流程会在 source（zh / en）质量上放大很多，source 错了就会被 16 倍 fanout 出去；
- 完全无人参与的 fire-and-forget 自动化——我们 Thai 那一次跑了一遍 agent-autonomous，跑通了，但前置条件是已经有 6 个 locale 跑通过这套流程、规约稳定，新 locale 完全沿用前述 spec 才有底气放手。

我们也不会把这套流程包装成「AI 翻译产品」——它的价值在于工艺被针对项目类型调好了，是工艺、不是产品。

## 总结

把两周的工艺压成几条规则：

1. **加新语言 → codex 写、Claude spec-review、codex cross-cutting review**。
2. **加 key → Claude 写、codex cross-review**。
3. **写谁审谁，永远是另一个**——这条比工具分工本身重要。
4. **并行 codex 必须带 4 条 sister-locale guard**，否则 silent trample。
5. **新 feature 首 commit 只填 zh / zh-hant / en**，其余 locale 单独 commit 补完。
6. **Script 逃生门 UI 文案硬编码**，不要进 i18n key。
7. **宽度敏感槽位用固定宽度 + per-locale fallback**，不要为长 locale 拉宽布局。

这些规则放在一起就是一份 16-locale 项目的 i18n 操作手册。背后只有一个原则：**让两个 AI 工具各做自己最稳的那一段、永远跨 context 互审、把不能靠 AI 自动收敛的产品决策识别出来硬编码**。剩下的让流程自己跑。

如果你也在做一个多 locale 项目、又有 AI agent 在手边，希望这篇能省下你的几次试错。
