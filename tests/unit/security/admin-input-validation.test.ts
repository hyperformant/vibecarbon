import { describe, expect, it } from 'vitest';
import { readRepoFile } from '../../_shared/source-files.js';

describe('C-8: create.js uses validateAdminEmail/Password from lib/validators', () => {
  it('create.js imports the strict validators', async () => {
    const src = readRepoFile('src', 'create.js');
    expect(src).toContain('validateAdminEmail');
    expect(src).toContain('validateAdminPassword');
  });

  it('create.js no longer uses the loose inline email regex', async () => {
    const src = readRepoFile('src', 'create.js');
    // The old pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    expect(src).not.toMatch(/\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+\$/);
  });
});
