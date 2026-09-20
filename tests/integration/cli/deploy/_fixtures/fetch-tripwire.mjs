/**
 * NODE_OPTIONS=--import preload — a network tripwire for the operator
 * config hygiene deploy integration tests (see ../deploy.test.ts).
 *
 * These tests exist to prove the gates run BEFORE the first network call a
 * deploy would otherwise make (a provider token's live verification,
 * fetchServerTypes, a DNS backend's zone lookup, ...). "No network call
 * happened" is easy to assert WRONG by inference (a passing test that
 * happens not to exercise the call is not proof it can't happen); this
 * preload turns it into a checkable fact instead: it makes ANY fetch()
 * print a sentinel line to stderr and reject immediately, so the test can
 * assert that sentinel line never appears in the CLI's captured output. If
 * a future change makes a network call before the gate runs, this preload
 * is what turns that regression into a loud, specific test failure instead
 * of a silent flake risk (or, worse, a real request with a fake credential).
 */
import { FETCH_TRIPWIRE_SENTINEL } from './fetch-tripwire-sentinel.mjs';

globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  console.error(`${FETCH_TRIPWIRE_SENTINEL} ${url}`);
  throw new Error(`${FETCH_TRIPWIRE_SENTINEL}: network call blocked in test`);
};
