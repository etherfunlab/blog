---
title: Nuxt + Supabase — four pitfalls from swapping Authorization headers for SSR cookies
description: A real migration from "client-side localStorage session + Bearer headers everywhere" to "SSR cookies + a server-side OAuth callback route". The post walks through before/after code, then reconstructs the four pitfalls production exposed (OAuth race, service-role env naming, partial SSR redirect, Playwright × Vue hydration race) — plus the Claude Code main-driver + Codex CLI second-reviewer workflow we used while debugging.
date: 2026-05-13
tags: [nuxt, supabase, ssr, auth, claude-code, agent-workflow]
draft: false
lang: en
---

One of our Nuxt 4 + Supabase projects recently went through a substantial auth migration.

The change was at the foundation: from "client-side localStorage session + each request hand-rolling its own `Authorization: Bearer` header" to "**SSR cookies** (login state stored in cookies the server can read) + a server-side OAuth callback route". It's the pattern Supabase's docs now recommend, and one Nuxt 4 has actively pushed in the same direction.

On paper, the design is clean. The new architecture is tighter, responsibilities are clearer, and the rollout was expected to be uneventful.

In production, it wasn't. Four pitfalls surfaced in a row, two of them outright incidents — intermittent login failures, and every cookie-auth endpoint returning 500. Each one had a very specific root cause, and each one only triggered with real production traffic.

This post does two things:

1. **A full before/after architecture comparison**: what the client, the server, and the OAuth callback look like in each version, what the SDK does for you, and what the SDK quietly won't tell you.
2. **A retrospective on the AI-pair debugging workflow we used**: throughout the investigation we ran Claude Code as the main-driver AI, and at every consequential decision point we additionally ran a fresh Codex CLI session to independently review — without ever showing it the main driver's conclusions. In hindsight that second reviewer caught material issues at three entirely different decision points.

If you're working on a Nuxt + Supabase SSR cookies migration, the first half is a working architecture checklist. If you care about how AI-pair workflows actually play out on real engineering work, the second half is where the meat is.

## The old architecture: Authorization Bearer everywhere

The old version is the straightforward shape most Supabase projects start with.

Login state lives in localStorage on the client. Every authed request handles its own auth: pull the token out, stuff it into an `Authorization` header.

**Client**: every authed fetch looked roughly like this:

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

Every call runs `getSession()` first to grab the access_token (a sync read from localStorage), then manually stuffs it into the `Authorization` header.

The line count isn't large, but there's a hidden cost: auth logic gets distributed across every call site. Add a new endpoint, forget to wrap it in `authedFetch`, and you get a very subtle 401 — looks like an expired session, but it's actually just a missing header.

**Server**: the server side wasn't trivial either. Every endpoint went through this helper:

```ts
// server/utils/supabaseService.ts (old, since-removed helper)
export async function getUserIdFromAuthHeader(req): Promise<string | null> {
  const auth = (req.headers.authorization || req.headers.Authorization) as string | undefined
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice('Bearer '.length)
  const supabase = getSupabaseService()
  const { data, error } = await supabase.auth.getUser(token)  // ← one remote round-trip per request
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

The line worth paying attention to is `supabase.auth.getUser(token)`.

This isn't a lightweight local verification. `supabase-js` actually fires an HTTP request to your Supabase project's `/auth/v1/user` endpoint, lets Supabase's backend validate the token, and waits for the user info to come back.

Which means **every authed endpoint, every request, adds one round-trip to Supabase Auth API**. At low traffic this is hard to notice; at high traffic, with cross-region latency, or when Supabase Auth itself has hiccups, every endpoint hiccups along with it.

**OAuth callback** (the page that handles the redirect back from Google) was also a client-side Vue page:

On mount, it calls `exchangeCodeForSession(code)`, the SDK writes the session into localStorage, `onAuthStateChange` fires, and finally `router.replace('/app')` pushes the user into the app.

The setup works, but the problem surface is structural:

1. **Server-side +1 latency per request**: every authed endpoint has to round-trip Supabase Auth API just to map token → user_id. When Supabase API stutters, every endpoint stutters in lockstep.
2. **OAuth callback is a race-condition disaster zone**: the SDK writes localStorage, `onAuthStateChange` fires, our own watcher and `@nuxtjs/supabase`'s built-in listener race to update `useSupabaseUser`, while `router.replace` is in flight. Whichever attempt loses the timing reads `null` from middleware and bounces the user back to `/login`.
3. **Manual token plumbing is easy to miss**: every new endpoint needs the developer to remember the helper. Over time, someone forgets.
4. **No server-side SSR auth gating**: the session lives in localStorage. The server at render time has no idea who the user is — not even "redirect anonymous visitors to `/login`" can be done server-side.

Four reasons add up to a clear migration motivation.

## The new architecture: SSR cookies + server callback

The core idea of the new architecture is one sentence: the client never needs to know about the token.

**Client** fetch becomes this:

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

`useRequestFetch` is Nuxt 4's official helper. In the browser it behaves like a regular `$fetch` — same-origin requests carry cookies automatically. During SSR, it forwards the current request's headers (including the `sb-*` cookies we care about) into the internal API call.

Not a single token in sight. The call site no longer needs to know what a token looks like, when it expires, or how to refresh it.

**Server**:

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

`serverSupabaseUser(event)` comes from `@nuxtjs/supabase`. It takes over the chore work: reads the chunked `sb-<projectref>-auth-token.0/.1` cookies from the request, reassembles the session JSON, then calls `client.auth.getClaims()` to verify the JWT locally.

That "verify locally" deserves emphasis. For ES256, `supabase-js` fetches JWKS (JSON Web Key Set — the public keys) once and caches; for HS256, it uses the local secret. **There is no outbound HTTP call to Supabase Auth API anywhere on this path.** That single change shaves a round-trip off every authed endpoint, and the p50 / p95 improvements show up cleanly.

One easy gotcha: the return value is `JwtPayload | null` — it's the JWT claims, **not** a `User` object. The user id lives at `claims.sub`, not `claims.id`.

**OAuth callback** becomes a Nitro server route:

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

The entire OAuth completion becomes a single synchronous chain: receive code, exchange for session, `@supabase/ssr` writes Set-Cookie, 302 to destination. By the time the browser loads the client app, the cookie is already in place. **In theory**, the race is gone.

This does open one surface that has to be reconsidered: CSRF.

The old `Authorization: Bearer` was a custom header — browsers don't attach it to cross-origin POSTs by default, so that route was naturally CSRF-resistant. Cookies aren't, so we put two layers in:

- **`SameSite=Lax`**: browser default that blocks the vast majority of cross-site POSTs from being authenticated.
- **`assertSameOrigin(event)`**: a one-liner at the top of every POST handler that compares `Origin` / `Referer` against the actual URL origin, as a belt-and-suspenders second layer.

That's the architecture. The more interesting story is the next part — **it didn't roll out the way the design doc said it would**.

## The AI-pair debugging workflow: Claude Code × Codex CLI

Three of the four pitfalls below were located or corrected using the same workflow. Worth introducing it once up front so the narrative downstream doesn't get tangled.

```
+---------- Claude Code (main-driver AI) -----+
|  Receives human requests / feedback         |
|  Reads / writes code, runs tests            |
|  Owns PRs, commits, long-term memory        |
|  Prepares prompts for codex review          |
+----------------------------------------------+
                    │
                    │ codex exec "$(cat prompt.md)"
                    ▼
+----------- Codex CLI (second reviewer) -----+
|  Receives a self-contained prompt           |
|  Independently reads code, runs searches    |
|  Doesn't see the main driver's conclusion  |
|  Returns structured feedback                |
+----------------------------------------------+
```

Why have a second reviewer?

When one AI sits in the same conversation with us through a debugging session, it builds up assumption inertia. The moment we say "I think it's a race condition," its subsequent searches, explanations, and fix plans all start leaning in that direction. Most of the time that inertia is useful — it makes the work fast. But when our initial hypothesis is wrong, the AI inherits the same wrong direction.

Codex CLI is launched with a brand-new context. The input it sees is just raw symptoms, the repo path, and a few instructions with no hints — it works directly against the original problem, without picking up any of the framing we've already settled on.

When both reviewers converge, confidence goes up and we move faster. When they diverge, we stop and figure out why. The blind spots almost always emerge from the divergences.

The three codex calls below are each one of those moments.

## Pit 1: OAuth landing intermittently bounces to /login

The day after deploy, users reported a very textbook login incident:

Click Sign in with Google → a flash of `/app` → bounced back to `/login?next=%2Fapp`.

It wasn't a stable reproduction. **Sometimes it would just work.**

Notice the URL doesn't carry `?error=`. That means `exchangeCodeForSession` didn't fail — cookies were written by the server, the browser carried them back. The problem wasn't in OAuth code exchange. It was somewhere in "Nuxt client boots, then middleware runs."

The main driver — Claude Code, running as Opus 4.7 on this stretch — held off on changing any code and went for evidence first. In the browser, a single line:

```js
> document.getElementById('__NUXT_DATA__')?.textContent
'[{"serverRendered":1},false]'
```

That output is critical. The Nuxt 4 SSR payload is empty. `useState('supabase_user')` is not in the payload. Even if server-side did write the user state, none of it reached the client.

### Codex call #1 (don't tell it our hypothesis)

By that point Opus already had a fuzzy intuition that this was a race. Rather than continue down its own path, it drafted a prompt to hand to Codex for a clean-slate review. The prompt was roughly:

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

What makes the prompt work is **restraint**:

- No leading: the prompt never reveals Opus's own preliminary read, so codex starts from raw symptoms.
- Pointers to material: repo path, recent commits, design doc location are all there, but no inferences.
- Output shape requested: list candidates, confidence each, discriminating evidence.

Codex ran a few minutes, independently read the server and client plugin source of `@nuxtjs/supabase`, and came back clear:

> **High confidence**: `/app` is CSR-only (`ssr: false`), so `useSupabaseUser()` is null when auth middleware runs. The installed `@nuxtjs/supabase@2.0.6` code doesn't populate `useSupabaseUser` before middleware on `ssr: false` routes when `useSsrCookies` is true. The design doc assumption appears wrong.

That converged with Opus's earlier read.

But codex also added two candidates Opus hadn't even listed: `is_anonymous: true` residue, and a cookiePrefix mismatch between two config paths. Both were ruled out later (JWT decode, env check), but **that's the direct value of two-AI review** — both reviewers converging on the same #1 (much higher confidence), and each independently filling in candidates the other missed (much lower chance of a shared blind spot).

### The actual root cause

The final localization is in two cooperating sections of `@nuxtjs/supabase`.

First, the client plugin:

```js
// runtime/plugins/supabase.client.js:39
if (!useSsrCookies) {
  const { data } = await client.auth.getSession();
  if (data.session) currentSession.value = data.session;
}
// With useSsrCookies=true this block is skipped! Only the async page:start hook calls getClaims.
```

Then the server plugin:

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

The server plugin does write the user.

But Nuxt's SSR payload for an `ssr: false` route is just `[{"serverRendered":1}, false]` — useState is never serialized into it. Layer on top of that the fact that Nuxt route middleware runs synchronously during `router.replace(initialURL)`, earlier than the `page:start` hook, and the client-side timing comes out as:

```
[client boot]
  ├─ supabase plugin (useSsrCookies=true → skip initial getSession)
  ├─ Router init → router.replace('/app') → sync middleware run
  │  └─ auth.ts: useSupabaseUser().value = null → bounce to /login
  └─ [too late] page:start hook async getClaims populates user
```

So "sometimes it works" isn't OAuth occasionally succeeding. It's `onAuthStateChange`'s async listener occasionally finishing earlier than middleware and populating user just in time.

### The fix

The patch itself is small:

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
  // ...original auth check
})
```

Five effective new lines.

The thing worth highlighting is that those five lines call `@nuxtjs/supabase`'s own already-exported `useSupabaseClient().auth.getClaims()`. We initially tried to wire up our own internal protocol — server plugin writes useState, payload carries it across, middleware reads it on the client — but one line of `getClaims()` makes the whole construction unnecessary. The "prefer upstream APIs" principle gets its own takeaway below.

## Pit 2: every cookie-auth POST returns 500 in production

Before the first bug was fully wrapped up, users reported the onboarding form was blowing up too:

`POST /api/profile/complete → 500`, with response body redacted to a generic `"Server Error"`.

Vercel function logs were unambiguous:

```
H3Error: Supabase service-role not configured
    at getSupabaseService (file:///var/task/chunks/_/serverSupabaseUser.mjs:12:11)
```

Anyone familiar with Nuxt will read that and immediately suspect the **`NUXT_*` prefix mismatch**.

Nuxt 4's runtime config env mapping rule is fixed: an env var must be prefixed `NUXT_`, with the field name camelCase converted to SCREAMING_SNAKE. So `runtimeConfig.supabaseServiceRoleKey` is only overridden in production by `NUXT_SUPABASE_SERVICE_ROLE_KEY`.

But our `.env` and our Vercel project both have it set as `SUPABASE_SERVICE_ROLE_KEY` — the name Supabase's own docs have been using all along.

The two naming schemes don't map to each other. Nuxt silently skips that field, the value stays empty string forever, and every endpoint that needs the service role key dies in production.

It never surfaced locally because dev-bypass goes through a mock path; in unit tests `getSupabaseService` was mocked end-to-end. This is a bug that only triggers under real production traffic, and most of our mutations hadn't seen real users yet.

### Codex call #2 (review the fix plan)

The three candidate fixes on the table:

| Option | Change |
|---|---|
| A | Rename in `.env` + Vercel to `NUXT_SUPABASE_SERVICE_ROLE_KEY` |
| B | Explicitly wire in nuxt.config: `supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''` |
| C | Drop `runtimeConfig.supabaseServiceRoleKey`, read `process.env` directly in the server-only util |

We leaned toward B, with the reasoning "it doesn't expose the key to Nuxt's runtimeConfig system, so it's more secure."

To keep that judgement honest, Opus packaged the plan and the team's reasoning together for codex review:

```md
The user picked Option B. Be a critical reviewer — find holes.
Is "more secure" actually true, or same exposure as Option A?
Are there pitfalls with process.env in nuxt.config (build time vs runtime)?
```

Codex pushed back directly on the "more secure" framing:

> Nuxt's official runtime config docs warn that `process.env.OTHER_VARIABLE` in `nuxt.config.ts` only works at build time and may break at runtime — runtime overrides require a matching `NUXT_*` env name. The "more secure" framing isn't accurate either; both A and B have the same exposure surface. The security boundary is `runtimeConfig` (server-only) vs `runtimeConfig.public`, not the env var name. **Pick C**: keep the key out of runtimeConfig entirely.

Factually, the "B is more secure than A" claim was wrong. Both options have identical exposure — the actual security boundary is between `runtimeConfig` (server-only) and `runtimeConfig.public` (shipped to the bundle). The presence or absence of `NUXT_` in the env name has nothing to do with it.

Worse, B carries a quiet break: `process.env.X` written at the top level of `nuxt.config.ts` only resolves at build time. If runtime override behavior changes in the future, the field silently becomes empty without anyone noticing.

So we went with C:

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

The generalized rule: **pure server-only secrets should read `process.env.X` directly**, without taking the detour through `runtimeConfig`. Keep `runtimeConfig` for values that need to be shared between server and universal middleware. That way external libraries (Supabase, Stripe, OpenAI) keep their official naming, and you don't bury a silent build-time-vs-runtime trap for your future self.

## Pit 3: partial SSR — `onMounted` or `setup` redirect?

After the first race was fixed, the structural root cause was still there: `/app/**` had `ssr: false` globally, and the SSR cookies payload pipeline was still neutered. The fix above is an operational patch that keeps the production race shut; the next step is to actually rebuild the architecture so we don't need that operational patch as the load-bearing piece.

First the scope decision:

| Option | Description |
|---|---|
| Full | Enable SSR for all `/app/**` |
| **Surgical** | Only SSR `/app/index` + `/app/onboarding`; leave `/app/chat/**` as CSR |

We picked surgical, for practical reasons: `/app/chat/**` runs a Pinia chat store and a Solana wallet adapter, both of which are profoundly SSR-unfriendly. Flipping those to SSR would invite hydration mismatch as a daily occurrence. The two pages that actually carry "OAuth landing + onboarding" are smaller, cleaner, and a much better trade.

Three concrete changes:

1. Delete the three `/app/**` `routeRules` in `nuxt.config.ts`, so the global SSR default applies again.
2. Switch `useProfile.fetch` to `useRequestFetch`, so the internal `/api/profile/me` call during SSR can actually see cookies. Without this, profile middleware silently fails open on the server pass and the onboarding gate gets bypassed.
3. Move the `/app/index.vue` redirect from `onMounted` to a setup-level `await navigateTo`.

The third one Opus didn't originally plan on.

`/app/index` is a contentless redirect page — its only job is to send the just-logged-in user onward to `/app/chat`. Opus's initial plan was to keep the `onMounted` redirect and let the server prime user state into the SSR payload, then have the client-side onMounted handle the navigation. In theory the downstream `/app/chat` would benefit from that primed state.

A human pushback flipped that decision. From the user's perspective, the browser visits `/app`, then onMounted moves it to `/app/chat` — the URL flashes through `/app` for a frame. Visible roughness. The intuition was: doing `await navigateTo` in setup is cleaner — a single server-side 302, no URL flash.

### Codex call #3 (single decision point)

"Human intuition vs. agent engineering rationale" arguments are easy to get tangled in. Opus wrote both options and both rationales out and handed them to codex:

```md
Option A (onMounted): SSR render → ship empty shell + payload → client hydrate
with populated user → router.replace('/app/chat').
Option B (setup await navigateTo): SSR setup → 302 → /app/chat (CSR) → seed
via seedSupabaseUser.

The user pushed back on my Option A pick saying "fewer redirects = better UX".
Is Option B actually better? Does its reliance on seedSupabaseUser introduce
new risk? If you had to pick one: which would you ship?
```

Codex's verdict was unequivocal:

> **Pick Option B.** The page exists only as a redirect target, and a server redirect is the correct semantic for a contentless landing route. The SSR-payload-priming trick you'd planned for is irrelevant because the destination `/app/chat/**` is `ssr: false` and discards the payload on full-page navigation — seedSupabaseUser is the load-bearing race-closure mechanism either way.

The pushback was correct.

The payload-priming Opus was optimizing for can't actually be caught downstream — `/app/chat` is `ssr: false`, so any full-page navigation throws the payload away. The race-closure on that side is already covered by the `seedSupabaseUser` from Pit 1. If priming is useless, then `onMounted` only buys the visible URL flash, with zero technical upside.

The final code is shorter than the original:

```vue
<script setup lang="ts">
definePageMeta({ middleware: ['auth', 'profile'] })

const localePath = useLocalePath()
await navigateTo(localePath('/app/chat'), { replace: true })
</script>
```

## Pit 4: Playwright × Vue 3 hydration race

After flipping `/app/onboarding` to SSR, all four existing wizard e2e tests timed out.

The symptom is straightforward: **the Next button is forever disabled** and never gets clicked.

But Next is v-model-driven — once the input has a valid value, the button is supposed to auto-enable. Playwright clearly ran `fill('Test User')`. So why doesn't the button come alive?

Once you lay out the timing, it's obvious:

```
[Browser]
  ├─ Receive SSR'd HTML: form rendered, inputs empty, Next disabled
  ├─ JS bundle downloads / parses / executes
  │
  │  [Playwright]
  │    └─ page.getByLabel(...).fill('Test User')
  │       └─ dispatch input event ← nothing listening yet!
  │
  └─ Vue mount() → attaches v-model handler, AND resets input.value to the reactive ref's initial (empty)
```

Playwright's `fill` runs earlier than Vue's mount.

The input event does get dispatched, but at that moment no Vue listener is attached. Right after that, Vue mounts and its binding syncs the DOM input back to the reactive ref — which is the empty initial state — overwriting whatever Playwright typed.

The usual fixes don't hold:

- `waitForLoadState('networkidle')` — Vite HMR keeps a long-lived socket open in dev, so the networkidle event never fires.
- `waitForTimeout(2s)` — not enough on cold compile; wasteful on hot.
- `pressSequentially({ delay: 50 })` — same race, just sliced into per-keystroke chunks. No real change.

What worked is a retry-fill pattern:

```ts
const input = page.getByLabel(/Display name/i)
const next = page.getByRole('button', { name: 'Next' })

await expect(async () => {
  await input.fill('Test User')
  expect(await next.isDisabled()).toBe(false)
}).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] })

await next.click()
```

The trick is that **each retry re-fills the input**.

If the first attempt collides with Vue's mount-time reset, the next attempt rewrites the value — and by then Vue's listener is attached, the input event actually gets heard, the ref updates, the button unlocks, and the assertion passes.

We treat this as a general template now. Any "SSR'd Vue/Nuxt form + Playwright" combination gets the same retry-fill shape.

## Lessons captured

We don't want these pitfalls to be one-time fixes. Each one is distilled into a long-term memory entry in Claude Code. Those memory files load automatically at the start of every new conversation, so the next time we write similar code, the relevant lesson gets pulled into context without anyone needing to remember:

```
~/.claude/projects/<...>/memory/
├── feedback_prefer_upstream_solutions.md
├── feedback_one_source_of_truth_per_config.md
├── nuxt_ssr_cookies_vs_render.md
└── feedback_playwright_vue_hydration_race.md
```

The four lessons:

1. **Prefer the upstream library's API.** `seedSupabaseUser` is five lines, all calling `@nuxtjs/supabase`'s already-exported `getClaims()`. We initially tried to invent our own protocol — server plugin writes useState, payload carries it across, middleware reads it. Just calling the upstream API is enough. Reimplementing functionality the library already provides becomes a silent bug source the next time the library updates.

2. **One source of truth per config value.** Server-only secrets read `process.env.X` directly; don't route them through `runtimeConfig`. Two layers of mapping mean two naming conventions, and eventually one of them will collide with the other — Supabase's `SUPABASE_*` running into Nuxt's `NUXT_*` is a real example.

3. **Nuxt SSR cookies ≠ per-route SSR rendering.** Two independent axes. `useSsrCookies: true` is about session transport; `ssr: false` is about render mode. **`ssr: false` routes always produce an empty SSR payload** — server-side useState writes don't reach the client.

4. **Playwright on SSR'd Vue forms uses retry-fill.** `networkidle` / `waitForTimeout` / `pressSequentially` are all flaky. Wrap fill + assertion in `expect.toPass({ intervals })` and let it retry until Vue's hydration catches up.

## Retrospective: why the two-AI workflow paid off

Looking back, all three codex calls did real work:

| Call | Main driver's read | Codex's feedback | Concrete effect |
|---|---|---|---|
| Initial investigation | `ssr: false` neuters the server plugin | Same #1 + 2 extra candidates | Blind spots don't disappear together |
| Fix-plan review | "Option B is more secure" | Pushed back: not more secure; pick C | Objective contradiction |
| Single decision point | "Keep onMounted redirect" | Setup-side is cleaner; here's why | Corrects a bad instinct |

A few concrete practices made the review effective:

- **Don't tell codex the main driver's hypothesis.** Give it raw symptoms, the repo path, and instructions without hints. Let it judge from zero.
- **Use a self-contained prompt file every time.** Background, task, output format — all written out explicitly. Don't accumulate context through multi-turn dialogue; that just smuggles our assumption inertia into the second reviewer too.
- **Codex reviews; only the main driver writes code.** Code changes stay with the main-driver AI — it shares the conversation with us and understands the full set of constraints and trade-offs.
- **Convergence buys confidence and speed; divergence is a stop sign.** Almost every divergence corresponded to a blind spot we hadn't seen.

The most important point: humans don't get replaced. The decisions that matter most — which option to ship, when to accept codex's pushback, when to stop, when to commit — stay with us. The AIs in this workflow break repetitive engineering work and "look at this again from scratch" into executable steps; judgement and trade-offs remain a human responsibility.

If you're working on a project with non-trivial structural complexity, and you happen to have two CLI tools you're comfortable with, this small "main driver + second reviewer" AI-pair is a setup worth trying. The marginal cost is roughly one extra `codex exec`, and the upside is catching a real reasoning bias at three completely different decision points.
