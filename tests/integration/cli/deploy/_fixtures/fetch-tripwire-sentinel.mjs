/**
 * The line `fetch-tripwire.mjs` prints on any network call. Side-effect
 * free (no fetch override here) so the test file can import this constant
 * directly without also monkey-patching ITS OWN global fetch — only the
 * spawned CLI child (via NODE_OPTIONS=--import) gets the tripwire.
 */
export const FETCH_TRIPWIRE_SENTINEL = '__VIBECARBON_TEST_FETCH_TRIPWIRE__';
