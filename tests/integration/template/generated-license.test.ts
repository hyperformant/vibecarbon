/**
 * A generated project is a copy of the MIT-licensed template, and MIT requires
 * the notice to travel with copies. `create` copies an explicit file list, so
 * nothing puts LICENSE in the project unless that list names it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { destroyRealProject, realProject } from '../_harness/real-project';

describe('create ships the template license', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) destroyRealProject(dir);
    dir = undefined;
  });

  it('copies LICENSE unchanged into the project', () => {
    dir = realProject();
    expect(readFileSync(join(dir, 'LICENSE'), 'utf8')).toBe(
      readFileSync(join(process.cwd(), 'carbon/LICENSE'), 'utf8'),
    );
  });
});
