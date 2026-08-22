import { describe, expect, it } from 'vitest';

describe('C-8: create.js uses validateAdminEmail/Password from lib/validators', () => {
  it('create.js imports the strict validators', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src', 'create.js'), 'utf-8');
    expect(src).toContain('validateAdminEmail');
    expect(src).toContain('validateAdminPassword');
  });

  it('create.js no longer uses the loose inline email regex', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src', 'create.js'), 'utf-8');
    // The old pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    expect(src).not.toMatch(/\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+\$/);
  });
});
