/**
 * Real `docker compose config` output, served by the stub `docker`s the
 * stack-pull and add-on-job unit tests run against.
 *
 * The fixture (tests/fixtures/compose-config-depends-on.json) was captured
 * from real compose: app and app-migrate share a local-only image and depend
 * on db. `config --images <svc>` prints the images of the service's
 * dependencies too (app prints its own image twice, then db's), so no shell
 * comparison of it against one image ever matches. A stub that answered one
 * image per service hid exactly that (DO e2e, 2026-11-01).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ComposeConfigFixture {
  composeVersion: string;
  compose: string;
  /** `config --format json`, verbatim. */
  config: string;
  /** `config --images <svc>`, verbatim, per service. */
  images: Record<string, string>;
}

export const COMPOSE_DEPENDS_ON_FIXTURE: ComposeConfigFixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', 'fixtures', 'compose-config-depends-on.json'),
    'utf-8',
  ),
);

/**
 * Writes the fixture's answers under `<dir>/.compose-config/` and returns the
 * shell for a stub `docker`'s `config` branch. It expects `$@` to start at the
 * compose subcommand (`config ...`), the `-f` set already shifted off.
 */
export function composeConfigStub(dir: string, fixture: ComposeConfigFixture): string {
  const base = join(dir, '.compose-config');
  mkdirSync(join(base, 'images'), { recursive: true });
  writeFileSync(join(base, 'config.json'), fixture.config);
  writeFileSync(join(base, 'services'), `${Object.keys(fixture.images).join('\n')}\n`);
  for (const [svc, out] of Object.entries(fixture.images)) {
    writeFileSync(join(base, 'images', svc), out);
  }
  return `case "$2 $3" in
    "--format json") cat "${base}/config.json" ;;
    "--services "*) cat "${base}/services" ;;
    "--images "*) cat "${base}/images/$3" ;;
    *) echo "stub docker: unexpected config $*" >&2; exit 2 ;;
  esac`;
}

/**
 * A fixture for a stack with no `depends_on`: every service prints only its
 * own image, which is what real compose does then.
 */
export function flatFixture(images: Record<string, string>): ComposeConfigFixture {
  const services = Object.fromEntries(Object.entries(images).map(([s, image]) => [s, { image }]));
  return {
    composeVersion: COMPOSE_DEPENDS_ON_FIXTURE.composeVersion,
    compose: '',
    config: JSON.stringify({ name: 'flat', services }, null, 2),
    images: Object.fromEntries(Object.entries(images).map(([s, image]) => [s, `${image}\n`])),
  };
}
