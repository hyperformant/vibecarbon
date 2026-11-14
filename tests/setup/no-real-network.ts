/**
 * The unit tier never reaches the real network: every connect and DNS query a
 * unit test makes goes through the checks in tests/_shared/no-real-network.ts,
 * which says what is allowed and why. A test that attempted anything else
 * fails, naming it, even when the code under test caught the error.
 *
 * Only the unit project adds this file (vitest.config.ts): the integration
 * tier may run servers and real Pulumi, and e2e is the real network.
 */
import { afterAll, afterEach } from 'vitest';
import { assertNoRefusals, installNoRealNetwork } from '../_shared/no-real-network.js';

installNoRealNetwork();

afterEach(() => {
  assertNoRefusals();
});

// A call after the file's last test (a request the code under test left
// running) fails the file instead of passing unseen.
afterAll(() => {
  assertNoRefusals();
});
