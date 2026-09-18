/**
 * Standard interactive-command opener: brand banner + update notice (when
 * one is cached) + clack intro line (`vibecarbon <command> v<VERSION>`).
 * Every command opens this way — one helper instead of the
 * printBanner()/p.intro() pair copy-pasted per file.
 */

import * as p from '@clack/prompts';
import { c, printBanner } from '../colors.js';
import { printUpdateNotice } from '../telemetry/update-check.js';
import { VERSION } from '../version.js';

/**
 * @param {string} command - label after "vibecarbon " (e.g. 'backup',
 *   'configure cicd')
 */
export function introCommand(command) {
  printBanner();
  printUpdateNotice();
  p.intro(`${c.bold(`vibecarbon ${command}`)} ${c.dim(`v${VERSION}`)}`);
}
