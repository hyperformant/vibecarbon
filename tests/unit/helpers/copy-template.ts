/**
 * Copy the carbon/ template into a test's temp dir. Installed dependencies
 * stay behind: a checkout with carbon/node_modules holds hundreds of thousands
 * of files no test reads, and copying them runs a test past its timeout.
 */
import { cpSync } from 'node:fs';
import { basename, join } from 'node:path';
import { REPO_ROOT } from '../../_shared/source-files.js';

const TEMPLATE = join(REPO_ROOT, 'carbon');

export function copyTemplate(dest: string): void {
  cpSync(TEMPLATE, dest, {
    recursive: true,
    filter: (src) => basename(src) !== 'node_modules',
  });
}
