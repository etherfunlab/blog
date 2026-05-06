# EtherFun Lab — Blog

Public blog at **https://blog.etherfun.xyz** — technical and product notes from the EtherFun team.

Built with [Astro 5](https://astro.build/) + Tailwind, hosted on GitHub Pages.
Design system reused from the internal `eros-reports` hub site (warm-ivory / plum
palette, Source Serif Pro typography, dual-theme Shiki code highlighting).

## Local development

```bash
nvm use            # Node 20
npm install
npm run dev        # http://localhost:4321
npm run build      # static site → ./dist
npm run preview    # serve ./dist locally
```

## Writing a post

Add a Markdown file under `src/content/posts/`. Filename becomes the slug.

```md
---
title: Your post title
description: One-line summary that shows in lists, OG tags, and RSS.
date: 2026-05-10
updated: 2026-05-12          # optional
tags: [tech, astro]
draft: false                  # true → hidden in prod, visible in dev
lang: zh                      # zh | en
---

Body in Markdown. Code blocks get Shiki dual-theme highlighting automatically.
```

Drafts (`draft: true`) are visible in `npm run dev` and hidden by `npm run build`.

## Project layout

```
src/
  content.config.ts        # posts collection schema
  content/posts/           # post Markdown files
  layouts/
    BaseLayout.astro       # site shell (header, footer, theme bootstrap)
    PostLayout.astro       # article wrapper used by post detail pages
  components/
    StatusBadge.astro      # DRAFT / ARCHIVED pill
    LocalTime.astro        # UTC fallback → viewer's local TZ in browser
  pages/
    index.astro            # post list
    posts/[...slug].astro  # post detail
    tags/index.astro       # tag cloud
    tags/[tag].astro       # tag archive
    about.astro
    rss.xml.js             # RSS feed
  styles/global.css        # CSS variables, theme tokens, prose tweaks
public/
  CNAME                    # blog.etherfun.xyz
  favicon.svg
  robots.txt
.github/workflows/deploy.yml  # CI → GitHub Pages
```

## Deploy

Pushes to `main` trigger `.github/workflows/deploy.yml`, which builds Astro and
publishes to GitHub Pages via `actions/deploy-pages@v4`.

### One-time setup

1. **Enable Pages** — Repo *Settings → Pages*: set **Source** to *GitHub Actions*.
2. **Custom domain** — Same page, set **Custom domain** to `blog.etherfun.xyz`
   and enable **Enforce HTTPS** (becomes available once DNS resolves).
3. **DNS** — At the registrar for `etherfun.xyz`, add a CNAME record:

   ```
   blog.etherfun.xyz.   CNAME   <github-username-or-org>.github.io.
   ```

4. **Wait for cert** — GitHub provisions a Let's Encrypt cert automatically;
   typically a few minutes after DNS resolves.

### Private repo note

GitHub Pages from a private repo requires a paid plan (Pro / Team / Enterprise).
If the org is on Free, options are:

- Make this repo public (simplest)
- Upgrade the org plan
- Switch the deploy target to Cloudflare Pages (also static, also free, supports
  private repos)

## Theme

The CSS variables in `src/styles/global.css` define the color palette. Light
theme is warm ivory + plum-pink; dark theme is plum-charcoal + lighter pink.
The toggle in the header writes to `localStorage`, and the inline bootstrap
script in `BaseLayout.astro` prevents FOUC on next load.
