import type { CollectionEntry } from 'astro:content';

type PostEntry = CollectionEntry<'posts'>;

/**
 * Strip `.zh.md` / `.en.md` (or just `.md`) from a filename to get the
 * lang-agnostic base slug. Astro's glob loader URL-slugifies `entry.id`
 * (dots removed), so `entry.filePath` is the only reliable source for
 * sibling pairing.
 *
 * Example:
 *   "src/content/posts/2026-05-08-foo.zh.md" → "2026-05-08-foo"
 *   "src/content/posts/2026-05-08-foo.en.md" → "2026-05-08-foo"
 *   "src/content/posts/2026-05-08-foo.md"    → "2026-05-08-foo"
 */
export function baseFromFilePath(filePath: string): string {
  const filename = filePath.split('/').pop() ?? filePath;
  return filename.replace(/\.(zh|en)\.md$/, '').replace(/\.md$/, '');
}

/**
 * Find the sibling-language version of a post within the collection.
 * Returns undefined if no sibling exists.
 */
export function findSibling(entry: PostEntry, all: PostEntry[]): PostEntry | undefined {
  if (!entry.filePath) return undefined;
  const base = baseFromFilePath(entry.filePath);
  const otherLang = entry.data.lang === 'zh' ? 'en' : 'zh';
  return all.find(
    (e) =>
      e.id !== entry.id &&
      e.filePath !== undefined &&
      baseFromFilePath(e.filePath) === base &&
      e.data.lang === otherLang,
  );
}

export type Lang = 'zh' | 'en';

/** Build a post URL given a base slug + language. EN is at root, ZH at /zh/. */
export function postUrl(baseSlug: string, lang: Lang): string {
  return lang === 'zh' ? `/zh/posts/${baseSlug}/` : `/posts/${baseSlug}/`;
}

/** Build a tag URL given the tag + language. */
export function tagUrl(tag: string, lang: Lang): string {
  return lang === 'zh' ? `/zh/tags/${tag}/` : `/tags/${tag}/`;
}

/** Resolve a sibling-language URL for an entry, if a sibling post exists. */
export function siblingUrlFor(entry: PostEntry, all: PostEntry[]): string | undefined {
  const sib = findSibling(entry, all);
  if (!sib?.filePath) return undefined;
  return postUrl(baseFromFilePath(sib.filePath), sib.data.lang);
}
