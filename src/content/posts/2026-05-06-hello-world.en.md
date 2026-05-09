---
title: Hello, EtherFun Lab
description: First post on EtherFun Lab — a placeholder to validate the theme, typography, and deploy pipeline.
date: 2026-05-06
tags: [meta]
draft: false
lang: en
---

Welcome to **EtherFun Lab**. This is a placeholder post to validate the template; real content will follow.

## What this site does

- Built with [Astro 5](https://astro.build/) + Tailwind — static, fast loads
- Light + dark themes (toggle in the header)
- Code blocks rendered with Shiki (dual-theme highlighting)
- Bilingual typography: Source Serif Pro for English headings, Noto Serif TC for Chinese

## A code block

```ts
// Code blocks render via Shiki — looks good in light + dark.
type Theme = 'light' | 'dark';

function toggleTheme(current: Theme): Theme {
  return current === 'light' ? 'dark' : 'light';
}

console.log(toggleTheme('light'));
```

## Blockquote

> Blockquotes use a soft accent border and muted text in both themes.

## List

1. First
2. Second
3. Third

—

If you can read this, then:

- Content collection config works
- The `posts/[...slug]` route is wired up
- `PostLayout` renders correctly
- Theme palette and fonts load fine

Next: write the first real article.
