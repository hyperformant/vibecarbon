/**
 * Stand-ins for a deployed server's Compose command in script tests.
 *
 * Server scripts reach Compose only through vc-compose
 * (src/lib/deploy/compose/command.js). A test that runs one writes the REAL
 * script into its project dir with writeVcCompose, and its `docker` stub starts
 * with DROP_COMPOSE_FILES_SH, which removes the `-f <file>` pairs vc-compose
 * adds, so the stub sees `compose <subcommand> ...` exactly as the caller
 * wrote it after `sh vc-compose`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderComposeCommand, VC_COMPOSE_SCRIPT } from '../../src/lib/deploy/compose/command.js';

/** The two files every server carries (composeFileFlags with no add-on). */
export const SERVER_BASE_FLAGS = '-f docker-compose.yml -f docker-compose.prod.yml';

/** Write the real vc-compose into a stand-in project dir. */
export function writeVcCompose(dir: string, flags = SERVER_BASE_FLAGS): void {
  writeFileSync(join(dir, VC_COMPOSE_SCRIPT), renderComposeCommand(flags));
}

/** First lines of a `docker` stub: drop vc-compose's `-f <file>` pairs. */
export const DROP_COMPOSE_FILES_SH =
  'if [ "$1" = compose ]; then shift; while [ "$1" = -f ]; do shift 2; done; set -- compose "$@"; fi\n';
