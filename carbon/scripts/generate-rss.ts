/**
 * Build-time RSS feed generator.
 *
 * Run: npx tsx scripts/generate-rss.ts
 *
 * Reads blog post frontmatter from content/blog/*.mdx and generates an RSS feed.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDraft } from './lib/seo-content';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PostMeta {
  slug: string;
  title: string;
  description: string;
  date: string;
  author?: string;
}

function loadSiteUrl(): string {
  try {
    const envContent = readFileSync(resolve(__dirname, '../.env.local'), 'utf-8');
    const match = envContent.match(/^SITE_URL=["']?(.+?)["']?\s*$/m);
    if (match) return match[1];
  } catch {
    // .env.local may not exist in CI
  }
  return process.env.SITE_URL || 'http://localhost:5173';
}

function loadProjectName(): string {
  try {
    const pkgContent = readFileSync(resolve(__dirname, '../package.json'), 'utf-8');
    const pkg = JSON.parse(pkgContent);
    return pkg.name || 'My SaaS';
  } catch {
    return 'My SaaS';
  }
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      fm[key.trim()] = rest.join(':').trim().replace(/^["']|["']$/g, '');
    }
  }
  return fm;
}

function loadPosts(): PostMeta[] {
  const blogDir = resolve(__dirname, '../content/blog');
  const files = readdirSync(blogDir).filter((f) => f.endsWith('.mdx'));

  return files
    .map((file): PostMeta | null => {
      const content = readFileSync(resolve(blogDir, file), 'utf-8');
      const fm = parseFrontmatter(content);
      if (isDraft(fm)) return null;
      return {
        slug: file.replace('.mdx', ''),
        title: fm.title || file.replace('.mdx', ''),
        description: fm.description || '',
        date: fm.date || new Date().toISOString(),
        author: fm.author,
      };
    })
    .filter((post): post is PostMeta => post !== null)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function generateRss(posts: PostMeta[], siteUrl: string, projectName: string): string {
  const items = posts
    .map(
      (post) => `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${siteUrl}/blog/${post.slug}</link>
      <description>${escapeXml(post.description)}</description>
      <pubDate>${new Date(post.date).toUTCString()}</pubDate>
      <guid>${siteUrl}/blog/${post.slug}</guid>
    </item>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(projectName)} Blog</title>
    <link>${siteUrl}/blog</link>
    <description>Updates, guides, and insights from ${escapeXml(projectName)}.</description>
    <language>en-us</language>
    <atom:link href="${siteUrl}/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const siteUrl = loadSiteUrl();
const projectName = loadProjectName();
const posts = loadPosts();
const rss = generateRss(posts, siteUrl, projectName);

const outDir = resolve(__dirname, '../dist/client');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'rss.xml'), rss);

console.log(`RSS feed generated with ${posts.length} posts → dist/client/rss.xml`);
