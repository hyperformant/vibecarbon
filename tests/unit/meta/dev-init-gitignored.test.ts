import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../_shared/source-files.js';

describe('dev-init outputs are gitignored', () => {
  it.each(['carbon/docker-compose.dev-init.yml', 'carbon/volumes/db/super-admin.generated.sql'])(
    '%s',
    (path) => {
      // --no-index: answer from .gitignore rules even if the path exists or is tracked.
      const out = execFileSync('git', ['check-ignore', '--no-index', path], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
      expect(out.trim()).toBe(path);
    },
  );
});
