import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
  const posts = (await getCollection('posts', ({ data }) => data.draft !== true))
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
  return rss({
    title: 'EtherFun Lab',
    description: 'EtherFun Lab — 技术与产品笔记',
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description ?? '',
      pubDate: post.data.date,
      link: `/posts/${post.id}/`,
    })),
  });
}
