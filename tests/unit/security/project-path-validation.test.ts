import { describe, expect, it } from 'vitest';
import { validateProjectName } from '../../../src/lib/validators.js';

describe('C-7: project path traversal rejection', () => {
  it.each([['../evil'], ['../../etc'], ['/abs/path'], ['foo/bar'], ['.hidden'], ['..'], ['.']])(
    'rejects non-basename %s',
    (bad) => {
      expect(validateProjectName(bad)).toBeTruthy();
    },
  );

  it.each([['my-app'], ['app1'], ['my-cool-saas']])('accepts simple basename %s', (good) => {
    expect(validateProjectName(good)).toBeUndefined();
  });
});

describe('C-7: create.js uses validateProjectName not the old loose isValidProjectName', () => {
  it('create.js no longer defines isValidProjectName', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src', 'create.js'), 'utf-8');
    expect(src).not.toMatch(/function isValidProjectName/);
    expect(src).toContain('validateProjectName');
  });

  it('create.js no longer defines a projectPath variable separate from projectName', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src', 'create.js'), 'utf-8');
    // The legacy code had `let projectPath = args.projectName;`
    expect(src).not.toMatch(/let projectPath = args\.projectName/);
  });
});
