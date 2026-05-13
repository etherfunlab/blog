---
title: Nuxt + Supabase：把 Authorization header 换成 SSR cookies 后，我们踩了四个坑
description: 一次从客户端 localStorage session + 到处传 Bearer header 切换到 SSR cookies + 服务端 OAuth callback 的真实迁移。文中给出新旧架构的代码对照，逐个还原 prod 暴露的四个坑（OAuth race、service-role env 命名、partial SSR redirect、Playwright × Vue hydration race），并描述我们在调试期间使用的 Claude Code 主驾 + Codex CLI 二审的双 AI 工作流。
date: 2026-05-13
tags: [nuxt, supabase, ssr, auth, claude-code, agent-workflow]
draft: false
lang: zh
---

我们的一个 Nuxt 4 + Supabase 项目最近做了一次 auth 改造。

具体改的是认证体系的底盘：从「客户端 localStorage session + 每个请求自己拼 `Authorization: Bearer` header」切到「**SSR cookies**（服务端渲染可读取的登录态 cookie）+ 服务端 OAuth callback 路由」。这是 Supabase 官方文档现在主推的姿势，也是 Nuxt 4 同期推动的方向。

设计稿是干净的。从架构图上看，新方案更紧凑、责任更清楚，应该顺利无痛上线。

但落到 prod 之后，连续冒出四个坑，其中两个直接是生产事故 —— 间歇性登录失败、所有 cookie auth 接口 500。每个坑都有它非常具体的根因，而且只有跑到生产才会触发。

这篇 blog 想做两件事：

1. **完整对照新旧两套架构**：客户端、服务端、OAuth callback 三段代码，分别长什么样、各自负责什么、为什么换、SDK 帮你做了哪些事、还有哪些事 SDK 不会主动告诉你。
2. **复盘我们使用的 AI 配对调试流程**：调试期间，我们用 Claude Code 作为主驾驶 AI 推进开发，每个关键决策点再用 Codex CLI 做一次独立 review —— 二审不看主线 AI 的结论，从原始症状重新判断。事后回头看，这套二审在三个完全不同的决策点都起了实质性作用。

如果你正在做 Nuxt + Supabase 的 SSR cookies 迁移，前半部分可以当成架构对照清单使用。如果你对 AI-pair 在真实工程里怎么落地感兴趣，后半部分更值得看。

## 旧架构：到处传 Authorization Bearer header

旧版的逻辑非常直观，也非常典型 —— 大部分 Supabase 项目早期都是这样做的。

登录态保存在客户端 localStorage 里。每一个需要认证的请求都自己负责：先把 token 取出来，再把它塞进 `Authorization` header。

**客户端**每个 authed fetch 大概长这样：

```ts
// app/composables/useProfile.ts (old)
async function authedFetch<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const session = supabase.client
    ? (await supabase.client.auth.getSession()).data.session
    : null
  const token = session?.access_token
  return $fetch<T>(url, {
    method: init.method as any,
    body: init.body as any,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

async function fetch() {
  // ...
  profile.value = await authedFetch<Profile | null>('/api/profile/me')
}
```

每次调用都先走一遍 `getSession()`，从 localStorage 同步读出 access_token，再手动拼进 `Authorization` header。

这一层模板代码看起来不长，但它有一个隐藏成本：auth 逻辑被强制散落在每一个调用点里。新加一个 endpoint，只要忘记包一层 `authedFetch`，就会得到一个非常隐蔽的 401 —— 表面是登录态过期，实际上只是漏写。

**服务端**这一侧也并不轻巧。下面这个 helper 是当时所有 endpoint 都要复用的入口：

```ts
// server/utils/supabaseService.ts (old，已删除的 helper)
export async function getUserIdFromAuthHeader(req): Promise<string | null> {
  const auth = (req.headers.authorization || req.headers.Authorization) as string | undefined
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice('Bearer '.length)
  const supabase = getSupabaseService()
  const { data, error } = await supabase.auth.getUser(token)  // ← 每请求一次远程往返
  if (error || !data.user) return null
  return data.user.id
}

// server/api/profile/me.get.ts (old)
export default defineEventHandler(async (event) => {
  const userId = await getUserIdFromAuthHeader(event.node.req as any)
  if (!userId) throw createError({ statusCode: 401 })
  // ... query as userId
})
```

需要特别留意那一行 `supabase.auth.getUser(token)`。

这并不是「拿 token 做一次本地验签」那么轻量。`supabase-js` 内部会真的对你的 Supabase 项目发一次 HTTP 请求 —— 打到 `/auth/v1/user` 这个端点，让 Supabase 后端帮你验 token 是否合法，再把 user 信息回传给你。

也就是说，**每一个 authed endpoint，每一次请求，都会多打一次 Supabase Auth API 的 round-trip**。在低流量阶段感受不明显；高流量、跨区延迟拉满、或 Supabase Auth API 本身抖动时，所有 endpoint 都会同时跟着抖。

**OAuth callback**（也就是 Google 登录跳回来的那个回调页）也是一个客户端 Vue page：

页面挂载时调 `exchangeCodeForSession(code)`，SDK 把 session 写进 localStorage，然后 `onAuthStateChange` 触发，最后 `router.replace('/app')` 把人推到应用主路径。

这套老路子能跑，但它的问题面在结构上是写死的：

1. **服务端每请求 +1 延迟**：每个 authed endpoint 都要跟 Supabase Auth API 往返一次才能拿到 user_id。Supabase API 一抖，整套接口跟着抖。
2. **OAuth callback 是 race condition 重灾区**：SDK 写 localStorage、`onAuthStateChange` 触发、我们自己挂的 watcher 又跟 `@nuxtjs/supabase` 内置 listener 抢着更新 `useSupabaseUser`，与此同时 `router.replace` 在飞。哪一次时序输了，middleware 读到 null user，用户就被弹回 `/login`。
4. **手动 token 管理特别容易漏**：每个新 endpoint 都要自觉包 helper，时间一长一定会有遗漏。
5. **server 端做不到 SSR auth-gate**：session 在 localStorage 里，server 端渲染那一刻完全不知道当前用户是谁，连最基本的「未登录用户跳 `/login`」都做不到 server-side 决策。

四条加起来，迁移已经是一个明确的需求。

## 新架构：SSR cookies + 服务端 callback

新架构的核心思路是一句话：让客户端彻底不用关心 token。

**客户端**的 fetch 变成这样：

```ts
// app/composables/useProfile.ts (new)
async function fetch() {
  if (loaded.value) return profile.value
  if (isDevBypass) { loaded.value = true; return profile.value }
  const requestFetch = useRequestFetch()
  profile.value = await requestFetch<Profile | null>('/api/profile/me')
  loaded.value = true
  return profile.value
}
```

`useRequestFetch` 是 Nuxt 4 的官方 helper。它在浏览器端的表现等同于普通 `$fetch`，同源请求由浏览器自动带 cookie 过去；在 SSR 渲染时，它会把当前请求的所有 headers 都 forward 给内部 API，包括我们关心的 `sb-*` 系列 cookie。

整段代码看不到任何 token。调用方再也不需要知道 token 长什么样、什么时候过期、怎么 refresh。

**服务端**：

```ts
// server/api/profile/me.get.ts (new)
import { serverSupabaseUser } from '#supabase/server'
import { getSupabaseService } from '#server/utils/supabaseService'

export default defineEventHandler(async (event) => {
  const claims = await serverSupabaseUser(event)
  const userId = claims?.sub
  if (!userId) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  // ... use service-role to query as userId
})
```

`serverSupabaseUser(event)` 来自 `@nuxtjs/supabase`。它接管了原来那段杂活：从请求的 `Cookie` 头读出 chunked 的 `sb-<projectref>-auth-token.0/.1`，拼回完整的 session JSON，再调用 `client.auth.getClaims()` 把里面的 JWT 在本地验签。

「本地验签」这一段值得放大说。ES256 第一次需要拉一次 JWKS（JSON Web Key Set，公钥集合），之后就走本地缓存；HS256 则直接用本地密钥。整条链路里**没有任何一次发出去打到 Supabase Auth API 的 HTTP 请求**。同样的逻辑在每个 endpoint 上少了一次外网往返，p50 / p95 都会显著好看。

有一个容易踩的小坑：返回值的类型是 `JwtPayload | null`，是 JWT claims，**不是** `User` 对象。需要的 user_id 在 `claims.sub` 里，不在 `claims.id` 上。

**OAuth callback** 重写成一个 Nitro 服务端路由：

```ts
// server/routes/auth/callback.get.ts (new)
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const code = q.code
  if (!code || typeof code !== 'string') {
    return sendRedirect(event, '/login?error=missing_code', 302)
  }
  try {
    const client = await serverSupabaseClient(event)
    const { error } = await client.auth.exchangeCodeForSession(code)
    if (error) return sendRedirect(event, '/login?error=exchange_failed', 302)
  } catch {
    return sendRedirect(event, '/login?error=exchange_failed', 302)
  }
  const target = safeNext(q.next, getRequestURL(event).origin)
  return sendRedirect(event, target, 302)
})
```

整个 OAuth 完成流程现在是单次同步链路：拿到 code、交换 session、`@supabase/ssr` 写 Set-Cookie、302 跳走。等浏览器开始加载客户端时，cookie 已经在那儿了，**理论上**不再有 race。

这里也带来一个需要重新规划的 surface：CSRF。

旧版 `Authorization: Bearer` 是自定义 header，跨域 POST 浏览器默认不会主动带，所以拿掉这层之后就要把这层防护补回来。新版用两道关：

- **`SameSite=Lax`**：浏览器默认行为，已经能挡掉绝大多数跨站 POST 自动认证场景。
- **`assertSameOrigin(event)`**：每个 POST handler 顶部加一句，比对当前请求的 `Origin` / `Referer` 和实际的 URL origin，作为多一道兜底。

到这里，新架构的代码层面就讲清楚了。但工程上更有意思的是后半段 —— **它没有按设计稿那样优雅落地**。

## AI-pair 调试工作流：Claude Code × Codex CLI

下面四个坑里，有三个是借助一套相同的工作流去定位 / 修正的。在开始拆坑之前先讲一下这套流程，后面的叙事会自然带上它。

```
+---------- Claude Code (主驾驶 AI) ----------+
|  接收人的需求 / 反馈                         |
|  读代码 / 写代码 / 跑测试                    |
|  维护 PR、commit、长期记忆                   |
|  关键决策点准备 prompt 让 codex 二审         |
+---------------------------------------------+
                    │
                    │ codex exec "$(cat prompt.md)"
                    ▼
+---------- Codex CLI (二审 reviewer) --------+
|  接收 self-contained prompt                 |
|  独立读代码 / 跑搜索 / 给意见               |
|  不看主线 AI 的结论 → 独立判断              |
|  输出结构化反馈给主驾驶                     |
+---------------------------------------------+
```

为什么需要这层二审？

当一个 AI 跟我们坐在同一个对话里推进调试时，它会很快建立起「假设惯性」。一旦我们说了一句「我感觉是个 race condition」，它后续的搜索路径、解释、修复方案都会沿着这个方向走。这种惯性大部分时候是好事 —— 它让推进很快 —— 但是当我们的初始假设错了的时候，它也会跟着错下去。

Codex CLI 是用一个全新的 context 启动的。我们给它的输入只有原始症状、仓库路径、几条不带提示的指令 —— 它直接对着原始问题工作，不沾我们这边已经形成的任何判断。

两边结论一致，可以提高置信度，继续推进；两边结论分歧，就停下来想清楚。很多关键盲点都是在分歧里浮上来的。

下面四个坑里，三次召唤 codex 的具体场景会一一展开。

## 坑 1：OAuth 落地后**间歇性**弹回 /login

部署当天，用户报告了一个非常典型的登录事故：

点 Google 登录 → 一闪到 `/app` → 立刻被弹回 `/login?next=%2Fapp`。

但它不是稳定复现。**有时候反而会成功**。

注意 URL 里没有 `?error=` 参数。这意味着 `exchangeCodeForSession` 没有失败 —— cookie 应该已经被服务端写出来了，浏览器也应该已经把它送回来了。问题不在 OAuth code exchange 那一段，问题在「随后 Nuxt 客户端启动 + middleware 执行」之间的时序。

主驾驶这一侧没急着动代码 —— Claude Code（这次跑的是 Opus 4.7）先去收证据。直接在浏览器里跑一行：

```js
> document.getElementById('__NUXT_DATA__')?.textContent
'[{"serverRendered":1},false]'
```

这个返回值很关键 —— Nuxt 4 的 SSR payload 是空的。`useState('supabase_user')` 没有出现在 payload 里。也就是说，即便 server 端确实写过 user state，这份 state 也根本没有进入 client。

### 第一次召唤 codex（不告诉它假设）

到这一步，Opus 这边其实已经隐约指向 race。但与其顺着继续走，更稳妥的做法是先让 codex 从零看一遍。Opus 起草的 prompt 大致是这样：

```md
You are debugging a production auth bug in this Nuxt 4 repo. Symptoms:
- User clicks Sign in with Google
- After OAuth completes, ends up at /app then immediately /login?next=%2Fapp
- No ?error= query parameter, sometimes succeeds

Recent context: last ~20 commits migrate auth from client-side OAuth callback
+ Authorization Bearer headers to SSR cookies + server-side /auth/callback route.

Your task: perform a fresh, independent root-cause investigation. Read code,
trace the flow, list candidate root causes with confidence levels, identify
any assumptions in the design doc that may be wrong.

Be skeptical. Don't propose fixes without evidence.
```

这个 prompt 的关键不在长，而在**克制**：

- 不引导：完全没提 Opus 当时的初步判断，让 codex 从原始症状起步。
- 指出材料：仓库路径、最近 commits、设计 doc 位置都给了，但不给推断。
- 要求格式：列 candidates，每个标 confidence，指出 discriminating evidence。

Codex 跑了几分钟，独立读了 `@nuxtjs/supabase` 的 server + client plugin 源码，结论很明确：

> **High confidence**: `/app` is CSR-only (`ssr: false`), so `useSupabaseUser()` is null when auth middleware runs. The installed `@nuxtjs/supabase@2.0.6` code doesn't populate `useSupabaseUser` before middleware on `ssr: false` routes when `useSsrCookies` is true. The design doc assumption appears wrong.

这跟 Opus 之前形成的判断收敛。

但 codex 还额外补出了两个 Opus 没有列上去的候选：`is_anonymous: true` 残留、cookiePrefix 在两套 config 路径里不一致。这两条后续通过解码 JWT 和检查 env 排除了，但**这就是双 AI 二审最直接的价值** —— 主路径上两边都指向 #1，置信度大幅提高；同时两边各自补出对方没列上的候选，盲点不容易一起漏。

### 真正的 root cause

最终源码定位到 `@nuxtjs/supabase` 模块里相互配合的两段。

先看 client plugin：

```js
// runtime/plugins/supabase.client.js:39
if (!useSsrCookies) {
  const { data } = await client.auth.getSession();
  if (data.session) currentSession.value = data.session;
}
// useSsrCookies=true 时这段跳过！只在 page:start hook 里异步 getClaims
```

再看 server plugin：

```js
// runtime/plugins/supabase.server.js:38
if (useSsrCookies) {
  const [session, user] = await Promise.all([
    serverSupabaseSession(event).catch(() => null),
    serverSupabaseUser(event).catch(() => null)
  ]);
  useSupabaseSession().value = session;
  useSupabaseUser().value = user;
}
```

server plugin 这一侧确实写了 user。

但 Nuxt 对 `ssr: false` 的路由产出的 SSR payload 只有 `[{serverRendered:1}, false]`，`useState` 完全没有被序列化。再叠上 Nuxt route middleware 在 `router.replace(initialURL)` 阶段是同步跑的，并且早于 `page:start` hook，最终在客户端时序就变成下面这样：

```
[client boot]
  ├─ supabase plugin (useSsrCookies=true → 跳过初始 getSession)
  ├─ Router init → router.replace('/app') → 同步跑 middleware
  │  └─ auth.ts: useSupabaseUser().value = null → 弹回 /login
  └─ [太晚] page:start hook 异步 getClaims 填 user
```

所以「有时候成功」并不是 OAuth 偶发成功。它只是 `onAuthStateChange` 异步监听器偶尔比 middleware 跑得快了一点，把 user 提前填进去了。

### 修复

修复非常薄：

```ts
// app/middleware/auth.ts
export async function seedSupabaseUser(): Promise<void> {
  const user = useSupabaseUser()
  if (user.value) return
  const supabase = useSupabaseClient()
  const { data } = await supabase.auth.getClaims()
  if (data?.claims) user.value = data.claims
}

export default defineNuxtRouteMiddleware(async (to) => {
  const cfg = useRuntimeConfig()
  if ((process as any).dev && cfg.public.devBypass === true) return
  if (import.meta.client) await seedSupabaseUser()
  // ...原 auth 检查
})
```

只有 5 行有效新增。

更值得说的是这 5 行调用的是 `@nuxtjs/supabase` 自己已经导出的 `useSupabaseClient().auth.getClaims()`。我们一开始想自己撮合一套「server plugin 写 useState → 通过 payload 把它传给 client → middleware 读取」的内部协议，但其实只要一行 `getClaims()` 就能解决。「上游 API 优先」这条原则后面会单独总结。

## 坑 2：所有 cookie auth POST 在 prod 全 500

第一个 bug 还没完全收尾，用户又报告 onboarding 提交炸了：

`POST /api/profile/complete → 500`，response body 是脱敏后的 `"Server Error"`。

去 Vercel function log 一看，错误原文非常清楚：

```
H3Error: Supabase service-role not configured
    at getSupabaseService (file:///var/task/chunks/_/serverSupabaseUser.mjs:12:11)
```

熟悉 Nuxt 的人会马上反应过来 —— **`NUXT_*` 前缀没对上**。

Nuxt 4 的 runtime config env mapping 规则是固定的：env var 必须以 `NUXT_` 开头，紧接着把字段名的 camelCase 转成 SCREAMING_SNAKE。也就是说，`runtimeConfig.supabaseServiceRoleKey` 在生产环境只会被 `NUXT_SUPABASE_SERVICE_ROLE_KEY` 这个 env 覆盖。

但我们的 `.env` 跟 Vercel 上设的都是 `SUPABASE_SERVICE_ROLE_KEY`，这是 Supabase 自家文档一直用的命名。

两套命名不映射。Nuxt 静默跳过这个字段，于是 `supabaseServiceRoleKey` 永远是空字符串 —— 所有依赖 service role key 的 endpoint 在 prod 全部死亡。

本地一次都没踩出来，是因为 dev-bypass 模式走的是 mock 路径；单元测试里 `getSupabaseService` 又被全程 mock 掉了。这套 bug 只在生产真实流量上才会暴露，而我们之前几乎所有 mutation 操作都还没在 prod 被真实用户触发过。

### 第二次召唤 codex（review fix plan）

当时摆在台面上的修复方案有三个：

| 方案 | 改动 |
|---|---|
| A | `.env` + Vercel 改名为 `NUXT_SUPABASE_SERVICE_ROLE_KEY` |
| B | `nuxt.config.ts` 显式 wire：`supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''` |
| C | 直接删 `runtimeConfig.supabaseServiceRoleKey`，util 里直接读 `process.env` |

我们一开始倾向 B，给的理由是「不把 key 暴露给 Nuxt runtimeConfig 体系，相对更安全」。

为了不让这个判断蒙混过关，让 Opus 把方案 + 我们给的理由一起打包给 codex review：

```md
The user picked Option B. Be a critical reviewer — find holes.
Is "more secure" actually true, or same exposure as Option A?
Are there pitfalls with process.env in nuxt.config (build time vs runtime)?
```

Codex 直接戳穿了「更安全」这个判断：

> Nuxt's official runtime config docs warn that `process.env.OTHER_VARIABLE` in `nuxt.config.ts` only works at build time and may break at runtime — runtime overrides require a matching `NUXT_*` env name. The "more secure" framing isn't accurate either; both A and B have the same exposure surface. The security boundary is `runtimeConfig` (server-only) vs `runtimeConfig.public`, not the env var name. **Pick C**: keep the key out of runtimeConfig entirely.

事实层面，「B 比 A 更安全」是错的。两个方案对外暴露面完全一样，真正的安全边界在 `runtimeConfig` 顶层（server-only）和 `runtimeConfig.public`（会进 bundle）之间，跟 env 名字里有没有 `NUXT_` 完全无关。

更要命的是 B 还埋了一个静默 break：`process.env.X` 写在 `nuxt.config.ts` 顶层只在 build time 求值；如果未来 runtime override 行为变化，整个字段会无声变空。

最后改成 C：

```diff
 // server/utils/supabaseService.ts
 export function getSupabaseService(): SupabaseClient {
   const cfg = useRuntimeConfig()
   const url = (cfg.public.supabaseUrl as string) || ''
-  const serviceKey = (cfg.supabaseServiceRoleKey as string) || ''
+  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
   // ...
 }
```

```diff
 // nuxt.config.ts
 runtimeConfig: {
-  supabaseServiceRoleKey: '',
   public: { ... }
 }
```

抽象成一条规则就是：**纯 server-only 的 secret，直接 `process.env.X` 读**，不要中间过一次 `runtimeConfig`。`runtimeConfig` 留给那些需要在 server + universal middleware 之间共享的值。这样既不需要为外部库（Supabase / Stripe / OpenAI）放弃它们的官方命名，也不会埋下 build-time vs runtime 的静默坑。

## 坑 3：partial SSR —— `onMounted` 还是 `setup` redirect？

第一个 race 修完之后，结构性的根因其实还在：`/app/**` 整个被打了 `ssr: false`，SSR cookies 的 payload 通道继续是废的。坑 1 的修复属于 operational fix，先把线上 race 关上；接下来这一步是把架构层面也补齐。

先定 scope：

| 方案 | 描述 |
|---|---|
| 全量 | 所有 `/app/**` 都开 SSR |
| **外科手术** | 只 SSR `/app/index` + `/app/onboarding`，`/app/chat/**` 继续保留 CSR |

最后选了外科手术，原因比较实际：`/app/chat/**` 里跑着 Pinia chat store 和 Solana wallet adapter，两个都对 SSR 极其不友好，贸然翻 SSR 一定会有 hydration mismatch。先把真正承担「OAuth 落地 + onboarding」的两个页面改掉，更小风险拿到更大收益。

需要改的地方一共 3 处：

1. `nuxt.config.ts` 里删掉 `/app/**` 的 3 条 `routeRules`，让全局 SSR 默认重新生效。
2. `useProfile.fetch` 改用 `useRequestFetch`，让 SSR 期间的 `/api/profile/me` 内部调用能拿到 cookie。否则 profile middleware 会在 server pass 上静默 fail-open，等于绕过了 onboarding gate。
3. `/app/index.vue` 的 redirect 从 `onMounted` 改成 setup-side `await navigateTo`。

第三处其实 Opus 一开始没打算动。

`/app/index` 是个内容为空的 redirect 页 —— 它的唯一作用就是把刚登录完的用户送到 `/app/chat`。Opus 一开始给出的方案是：保留 `onMounted` redirect，让 server 先把 user 灌进 SSR payload，再让 client 端的 onMounted 跳走，理论上下游 `/app/chat` 也能复用这份 SSR payload。

但人这一侧反推：用户实际看到的体验里，浏览器会先到 `/app`，再被 onMounted 推到 `/app/chat`，URL 在 `/app` 上停一帧。这是肉眼能察觉的小毛糙。直觉上 `setup` 里直接 `await navigateTo` 更干净 —— server-side 单次 302 就完事，URL 根本不会停在 `/app` 上。

### 第三次召唤 codex（单一决策点）

这种「人的直觉 vs Agent 的工程理由」对决，最容易因为讲不清前提而互相绕。让 Opus 把两个方案 + 各自的理由都写清楚交给 codex：

```md
Option A (onMounted): SSR render → ship empty shell + payload → client hydrate
with populated user → router.replace('/app/chat').
Option B (setup await navigateTo): SSR setup → 302 → /app/chat (CSR) → seed
via seedSupabaseUser.

The user pushed back on my Option A pick saying "fewer redirects = better UX".
Is Option B actually better? Does its reliance on seedSupabaseUser introduce
new risk? If you had to pick one: which would you ship?
```

Codex 的回答非常硬：

> **Pick Option B.** The page exists only as a redirect target, and a server redirect is the correct semantic for a contentless landing route. The SSR-payload-priming trick you'd planned for is irrelevant because the destination `/app/chat/**` is `ssr: false` and discards the payload on full-page navigation — seedSupabaseUser is the load-bearing race-closure mechanism either way.

这次反驳很对。

Opus 想要的 payload-priming 在下游 `/app/chat` 上根本接不住 —— 那里 `ssr: false`，full-page navigation 一定会把 payload 丢掉，能依靠的还是坑 1 那次修复留下的 `seedSupabaseUser` 兜底。既然 priming 没用，那 `onMounted` 留着只剩下 UX 上的小毛糙，没有任何技术收益。

最终的代码反而更短：

```vue
<script setup lang="ts">
definePageMeta({ middleware: ['auth', 'profile'] })

const localePath = useLocalePath()
await navigateTo(localePath('/app/chat'), { replace: true })
</script>
```

## 坑 4：Playwright × Vue 3 hydration race

把 `/app/onboarding` 翻成 SSR 之后，4 个现有的 wizard e2e 测试全部 timeout。

现象很直白：**Next button 永远 disabled**，从来没被点动过。

但 button 是被 v-model 驱动的 —— 只要 input 里有合法内容，按钮就该自动启用。Playwright 明明跑了 `fill('Test User')`，为什么 button 没活过来？

时序拆开来就清楚了：

```
[Browser]
  ├─ 收到 SSR'd HTML：form 已渲染，输入框为空，Next disabled
  ├─ JS bundle 下载 / parse / execute
  │
  │  [Playwright]
  │    └─ page.getByLabel(...).fill('Test User')
  │       └─ dispatch input event ← 还没人接！
  │
  └─ Vue mount() → 才挂 v-model handler，同时把 input.value 重置回 reactive ref 初始值（空）
```

Playwright 的 `fill` 跑得比 Vue 的 mount 更早。

input event 是被 dispatch 出去了，但此时还没有任何 Vue listener 在听。紧接着 Vue 真正 mount 起来，binding 把 DOM 里的值同步回 reactive ref —— 而 ref 的初始值就是空字符串，于是 Playwright 写进去的内容被覆盖掉了。

试过的几个常规方案都不稳：

- `waitForLoadState('networkidle')` — Vite HMR 在 dev 模式下保持一条 socket 长连，networkidle 事件永远不会到。
- `waitForTimeout(2s)` — 冷编译时往往不够，热编译时又纯属浪费。
- `pressSequentially({ delay: 50 })` — 跟 `fill` 一样的 race，只是把它拆成了 per-keypress 粒度，没有改变本质。

最终用 retry-fill pattern：

```ts
const input = page.getByLabel(/Display name/i)
const next = page.getByRole('button', { name: 'Next' })

await expect(async () => {
  await input.fill('Test User')
  expect(await next.isDisabled()).toBe(false)
}).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] })

await next.click()
```

关键是**每一次重试都重新 fill 一次**。

如果第一次 fill 撞上了 Vue mount 把值 reset 掉，那下一轮重试就会重新写入；而下一轮的时候 Vue 已经挂好 listener，input event 这次真的会被听到，ref 跟着更新，button 解锁，断言通过。

这个 pattern 我们直接当作通用模板沉淀下来 —— 所有「SSR'd Vue/Nuxt form + Playwright」的组合都可以套这个写法。

## 教训沉淀

这几个坑我们不希望只修一次就过。每一条都被抽出来写成 Claude Code 的长期记忆条目。这些 memory 文件会在每次开新对话时自动加载，下次再写类似场景的代码时，相关教训会自然带进上下文，不需要谁来手动提醒：

```
~/.claude/projects/<...>/memory/
├── feedback_prefer_upstream_solutions.md
├── feedback_one_source_of_truth_per_config.md
├── nuxt_ssr_cookies_vs_render.md
└── feedback_playwright_vue_hydration_race.md
```

四条内容如下：

1. **上游官方 API 优先**。`seedSupabaseUser` 就 5 行，调的全是 `@nuxtjs/supabase` 模块已经导出的 `getClaims()`。我们一开始想自己拼一条 server-plugin → useState → SSR payload 的内部协议，但其实只要直接调上游 API 就够。重新实现上游已经提供的东西，未来 lib 更新时就是一个静默 bug 源。

2. **一个 config 值只走一条路径**。Server-only secret 直接 `process.env.X`，不要中转到 `runtimeConfig`。两层映射意味着两套命名约定，迟早会撞上 —— Supabase 的 `SUPABASE_*` 撞上 Nuxt 的 `NUXT_*` 就是一个真实例子。

3. **Nuxt SSR cookies ≠ per-route SSR rendering**。这两件事是两个独立的轴。`useSsrCookies: true` 改的是 session 的传输介质；`ssr: false` 改的是渲染模式。**`ssr: false` 路由的 SSR payload 永远是空的**，server-side useState 写了也送不到 client。

4. **Playwright on SSR'd Vue forms 用 retry-fill**。`networkidle` / `waitForTimeout` / `pressSequentially` 三种常规等待都不稳。包一层 `expect.toPass({ intervals })`，让它重试到 Vue hydration 把 listener 接上为止。

## 复盘：双 AI 工作流为什么有用

事后回看，三次召唤 codex 都不是程序员的仪式感：

| 召唤点 | 主线 AI 的判断 | Codex 的反馈 | 实际效果 |
|---|---|---|---|
| 初步调查 | `ssr: false` 让 server plugin 失效 | 同样的 #1 + 额外补 2 个候选 | 盲点不会一起漏 |
| Fix plan review | "B 方案更安全" | 戳穿 "更安全" 是误判，推荐 C | 客观反驳 |
| 单一决策点 | "保留 onMounted redirect" | 推荐 setup-side，理由更扎实 | 直觉错时矫正 |

让二审有效的几个具体做法：

- **不告诉 codex 主驾驶已经形成的假设**。给原始症状、仓库路径、不带提示的 prompt，让它从零判断。
- **每次都用 self-contained prompt 文件**。背景、任务、输出格式都写清楚，不要靠多轮对话累积上下文 —— 那会把假设惯性也带过去。
- **让 codex 只评，不让它直接改代码**。改代码的事归主线 AI 做 —— 主线 AI 跟我们在一个对话里，理解完整的上下文和取舍。
- **结论收敛时提高置信、推进得更快；结论分歧时停下来想清楚**，几乎每次分歧都对应一个我们没看到的盲点。

最关键的一点：人没有被替代掉。所有最重要的判断 —— 接受哪个方案、接不接受 codex 的反驳、什么时候停下来、最终拍板 —— 都还在我们手上。AI 在这套流程里负责把工程上的重复劳动和「再独立看一遍」拆成可执行步骤；判断和取舍依然是人在做。

如果你在做一个有一定结构复杂度的项目，又恰好同时有两个手感不错的 CLI 工具可以挂，这种「主驾 + 二审」的小型 AI-pair 是个值得一试的姿势。它的成本几乎只多一次 `codex exec`，但能在三个完全不同的关键决策点接住一次推理偏差。
