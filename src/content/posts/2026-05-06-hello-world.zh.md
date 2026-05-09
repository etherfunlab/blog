---
title: Hello, EtherFun Lab
description: 这是 EtherFun Lab 的第一篇文章 — 用来验证主题、排版和部署管线。
date: 2026-05-06
tags: [meta]
draft: false
lang: zh
---

欢迎来到 **EtherFun Lab**。这是一个用来验证模板的占位文章，
真正的内容会陆续填上。

## 这个站点能做什么

- 用 [Astro 5](https://astro.build/) + Tailwind 构建，静态生成、加载极快
- 同时支持浅色 / 深色主题（顶部按钮可切换）
- 代码块用 Shiki 双主题高亮
- 支持中文衬线 + 英文 Source Serif Pro 的双语正文排版

## 一个代码块

```ts
// 代码块用 Shiki 渲染，浅色 + 深色主题都好看
type Theme = 'light' | 'dark';

function toggleTheme(current: Theme): Theme {
  return current === 'light' ? 'dark' : 'light';
}

console.log(toggleTheme('light'));
```

## 引用块

> 引用块在浅色和深色主题下都用柔和的边框和文字色。

## 列表

1. 第一条
2. 第二条
3. 第三条

—

如果你看到这一页，说明：

- 内容集合（content collection）配置正常
- `posts/[...slug]` 路由生效
- `PostLayout` 渲染正确
- 主题色板和字体正常加载

下一步：写第一篇真正的文章。
