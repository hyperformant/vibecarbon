/**
 * Shared content helpers for the build-time SEO generators
 * (scripts/generate-seo.ts, scripts/generate-sitemap.ts).
 */

export function parseFrontmatter(content: string): { fm: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { fm: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      fm[key.trim()] = rest.join(':').trim().replace(/^["']|["']$/g, '');
    }
  }
  return { fm, body: content.slice(match[0].length) };
}

/** Pages marked `draft: true` never reach crawler-facing artifacts. */
export function isDraft(fm: Record<string, string>): boolean {
  return fm.draft === 'true';
}

/**
 * Replace MDX prop expressions like `{props.projectName}` with concrete
 * values. The client evaluates these as JSX at render time (see
 * src/client/pages/Legal.tsx), but the generators feed raw markdown to
 * remark, which would pass the tokens through verbatim into crawler HTML.
 * Unknown props are left untouched so they stay visible in review.
 */
export function substituteMdxProps(body: string, props: Record<string, string>): string {
  // Replacement function, not string: values containing $-patterns ($&, $1,
  // $$) must survive verbatim. Object.hasOwn: `{props.constructor}` must not
  // resolve through the prototype chain.
  return body.replace(/\{props\.([A-Za-z_$][\w$]*)\}/g, (token, key: string) =>
    Object.hasOwn(props, key) ? props[key] : token
  );
}
