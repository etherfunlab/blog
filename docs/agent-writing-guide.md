# Agent 写作规范

这份规范给负责生成或润色 `blog.etherfun.xyz` 内容的 agent 使用。目标是写出适合公开技术博客的文章，而不是内部恢复上下文的 dev-log。

## 基本定位

Blog 面向公开读者：开发者、技术合伙人、开源用户、潜在投资人和候选人。文章可以有工程判断和产品观点，但默认会被不了解内部上下文的人阅读。

写作时优先回答三个问题：

- 这篇文章要解释哪个技术判断。
- 这个判断背后的约束是什么。
- 读者能从我们的实现里带走什么。

## 推荐工作流

写作建议分两步走：

- **起草** —— 由 Claude Code Opus 系模型完成。Opus 在长篇结构、语气连续性和工程论证上更稳，适合拿到内部上下文（dev-log、源码、schema）之后输出第一稿。
- **润色** —— 由 Codex GPT 系模型完成。GPT-5.5 这一类模型在事实核查、术语一致性、frontmatter 格式上更稳，适合把第一稿改成可发布版本。

这不是硬性要求，但目前两个家族的强项不重合 —— Opus 容易在复盘类文章里多写一层情绪，GPT 容易在长篇里失去叙事节奏。两阶段交接可以同时拿到两边的优点。

文章末尾的 byline 建议反映实际分工，例如：

> *Prompted by &lt;人名&gt;, written by &lt;起草模型&gt; and revised by &lt;润色模型&gt;*

## 语气

- 使用技术博客口吻：直接、克制、可验证。
- 少用内部口头禅、玩笑、自我对话和“未来的自己”口吻。
- 可以写明确观点，但要给工程理由。
- 不写营销式夸张语，例如“颠覆”“革命性”“遥遥领先”。
- 不把竞争产品写成靶子。可以比较 trade-off，但不要嘲讽。

## 技术名词

Blog 允许直接使用计算机专业名词。不要为了“显得正式”把通用术语硬翻译成中文。

可以直接使用：

- AI / LLM：LLM、RAG、embedding、prompt、system prompt、agent、persona、PDE、A2A。
- Backend：API、SDK、REST、gRPC、SQL、Postgres、pgvector、schema、migration、endpoint、webhook。
- Infra：p95、p99、RTT、queue、worker、backoff、CI/CD、deploy、observability、trace。
- Web / security：OAuth、JWT、JWKS、HMAC、CSRF、XSS、CORS、TLS、cookie、session。
- Rust：crate、workspace、trait、enum、Axum、Tokio、sqlx、serde。

首次出现时，如果读者可能不熟悉，可以加短解释。例如：

- `pgvector` 是 Postgres 的 vector search 扩展。
- `PDE` 在本文中指 Persona Decision Engine。

## 文章结构

技术复盘建议使用这个顺序：

1. 背景：我们在做什么，为什么这个问题重要。
2. 抽象：先定义问题边界，不急着讲实现。
3. 约束：列出延迟、成本、调试性、数据边界、维护成本等工程约束。
4. 实现：给 schema、pipeline、模块边界或伪代码。
5. Trade-off：说明放弃了什么，为什么可以接受。
6. 适用边界：谁适合用，谁不适合用。
7. 当前状态：哪些已经上线，哪些是计划，哪些只是设计。

如果文章来自 `eros-reports/dev-logs/`，必须把内部恢复上下文改写成公开叙事：

- 删除“你两周前在做什么”这类第二人称段落。
- 删除无法公开验证或不应公开的内部路径、私有仓库细节和过细的成本推演。
- 保留关键技术判断、架构图、schema、状态机和 trade-off。
- 对历史状态使用明确日期，例如“截至 2026-05-08”。

## 事实核查

写完前必须检查事实类型：

- 当前价格、模型名、官方产品能力、license、公开仓库状态必须核查。
- 内部实现细节以仓库和 `eros-reports` 为准，但要避免把计划写成已上线。
- 成本数字必须写清单位：per token、per 1M tokens、per request、per month 不能混用。
- 如果数字来自内部测试，写成“内部测试约为”，不要包装成行业 benchmark。
- 如果外部价格会变化，使用“截至 YYYY-MM-DD 核查”的表述。

## 格式

- Markdown frontmatter 必须符合 `src/content.config.ts`。
- 标题用中文，slug 用英文或现有文件名。
- 代码块必须标明语言。
- 表格用于比较 trade-off；列表用于枚举 scope、步骤或适用场景。
- 文件路径、crate 名、表名、endpoint、模型名使用反引号。
- 中文正文使用全角标点，英文术语两侧按可读性留空格。

## 禁止项

- 不编造 benchmark、用户数据、融资进度或线上事故。
- 不把未实现功能写成已上线。
- 不公开私有密钥、内部域名、非公开仓库路径、个人信息或合规敏感细节。
- 不为了降低门槛删除必要的技术名词。
- 不把内部 brainstorm 里的未经确认判断直接发布成结论。
