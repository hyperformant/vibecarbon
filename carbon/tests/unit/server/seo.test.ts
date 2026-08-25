import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// seo.ts imports logger (which pulls in env validation at import time) — mock
// it so this unit test is hermetic.
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { createSeoShell, escapeHtml, injectSeo } = await import('@server/lib/seo');

// Mirrors the shape of the built dist/client/index.html: the tags injectSeo
// rewrites must already exist in the shell for the replacement to land.
const SHELL = `<!DOCTYPE html>
<html>
  <head>
    <title>My SaaS</title>
    <meta name="description" content="Default description" />
    <meta property="og:title" content="My SaaS" />
    <meta property="og:description" content="Default description" />
    <meta property="og:url" content="https://example.com" />
    <meta name="twitter:title" content="My SaaS" />
    <meta name="twitter:description" content="Default description" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

describe('escapeHtml', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'
    );
  });
});

describe('injectSeo', () => {
  it('replaces title and description metas', () => {
    const out = injectSeo(SHELL, {
      title: 'Getting Started | My SaaS',
      description: 'Set up your project in five minutes.',
    });
    expect(out).toContain('<title>Getting Started | My SaaS</title>');
    expect(out).toContain(
      '<meta name="description" content="Set up your project in five minutes." />'
    );
    expect(out).toContain('<meta property="og:title" content="Getting Started | My SaaS" />');
    expect(out).toContain(
      '<meta name="twitter:description" content="Set up your project in five minutes." />'
    );
    expect(out).not.toContain('Default description');
  });

  it('escapes metadata values so they cannot break out of attributes', () => {
    const out = injectSeo(SHELL, {
      title: 'A "quoted" <title>',
      description: 'desc with "quotes" & <tags>',
    });
    expect(out).toContain('<title>A &quot;quoted&quot; &lt;title&gt;</title>');
    expect(out).toContain('content="desc with &quot;quotes&quot; &amp; &lt;tags&gt;"');
    expect(out).not.toContain('content="desc with "');
  });

  it('adds canonical link and rewrites og:url', () => {
    const out = injectSeo(SHELL, {
      title: 't',
      description: 'd',
      canonical: 'https://example.com/docs/getting-started',
    });
    expect(out).toContain(
      '<link rel="canonical" href="https://example.com/docs/getting-started" />'
    );
    expect(out).toContain(
      '<meta property="og:url" content="https://example.com/docs/getting-started" />'
    );
  });

  it('injects JSON-LD with < escaped so data cannot close the script tag', () => {
    const out = injectSeo(SHELL, {
      title: 't',
      description: 'd',
      jsonLd: { '@type': 'TechArticle', headline: '</script><script>alert(1)</script>' },
    });
    expect(out).toContain('<script type="application/ld+json">');
    expect(out).not.toContain('</script><script>alert(1)');
    expect(out).toContain('\\u003c/script>\\u003cscript>');
  });

  it('injects content HTML into the root div', () => {
    const out = injectSeo(SHELL, {
      title: 't',
      description: 'd',
      html: '<main><h1>Hello</h1></main>',
    });
    expect(out).toContain('<div id="root"><noscript><main><h1>Hello</h1></main></noscript></div>');
  });

  // Regression: String.replace expands $-patterns ($1, $&, $`, $', $$) in
  // replacement STRINGS after escaping has run; injectSeo must use replacement
  // functions so dollar signs in benign content survive verbatim.
  it('preserves literal $-patterns in escaped metadata', () => {
    const out = injectSeo(SHELL, {
      title: 'Price $1 $$ $& end',
      description: "Plans start at $1 per month, $` and $' included.",
    });
    expect(out).toContain('<title>Price $1 $$ $&amp; end</title>');
    expect(out).toContain('content="Plans start at $1 per month, $` and $&#39; included."');
  });

  it('preserves literal $-patterns in JSON-LD and content HTML', () => {
    const out = injectSeo(SHELL, {
      title: 't',
      description: 'd',
      jsonLd: { code: 'DO $$ BEGIN END $$; with $` inside' },
      html: "<pre>DO $$ BEGIN END $$;</pre> tail $' marker",
    });
    expect(out).toContain('"code":"DO $$ BEGIN END $$; with $` inside"');
    expect(out).toContain(
      "<div id=\"root\"><noscript><pre>DO $$ BEGIN END $$;</pre> tail $' marker</noscript></div>"
    );
  });
});

describe('createSeoShell', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup(opts: { manifest?: object | null; shell?: boolean } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'seo-test-'));
    const shellPath = join(dir, 'index.html');
    const manifestPath = join(dir, 'route-meta.json');
    if (opts.shell !== false) writeFileSync(shellPath, SHELL);
    if (opts.manifest !== null) {
      writeFileSync(
        manifestPath,
        JSON.stringify(
          opts.manifest ?? {
            routes: {
              '/docs/getting-started': {
                title: 'Getting Started | My SaaS',
                description: 'Docs',
              },
            },
          }
        )
      );
    }
    return createSeoShell(shellPath, manifestPath);
  }

  it('injects metadata for known routes', () => {
    const shell = setup();
    expect(shell.render('/docs/getting-started')).toContain(
      '<title>Getting Started | My SaaS</title>'
    );
  });

  it('normalizes trailing slashes', () => {
    const shell = setup();
    expect(shell.render('/docs/getting-started/')).toContain(
      '<title>Getting Started | My SaaS</title>'
    );
  });

  it('serves the plain shell for unknown routes', () => {
    const shell = setup();
    expect(shell.render('/dashboard')).toBe(SHELL);
  });

  it('serves the plain shell when the manifest is missing', () => {
    const shell = setup({ manifest: null });
    expect(shell.render('/docs/getting-started')).toBe(SHELL);
  });

  it('returns null when the shell itself is unreadable', () => {
    const shell = setup({ shell: false });
    expect(shell.render('/')).toBeNull();
  });
});
