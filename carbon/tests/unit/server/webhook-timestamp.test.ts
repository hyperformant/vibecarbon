import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFreshWebhookTimestamp } from '@server/billing/webhook-timestamp';

// The replay guard Paddle's and Polar's webhook verifiers share.

const NOW_SEC = 1_800_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('assertFreshWebhookTimestamp', () => {
  it('accepts a timestamp up to 5 minutes either side of now', () => {
    for (const offset of [0, 300, -300]) {
      expect(() => assertFreshWebhookTimestamp(String(NOW_SEC + offset), 'Paddle')).not.toThrow();
    }
  });

  it('rejects one older or newer than that, naming the provider', () => {
    expect(() => assertFreshWebhookTimestamp(String(NOW_SEC - 301), 'Paddle')).toThrow(
      'Paddle webhook timestamp outside tolerance'
    );
    expect(() => assertFreshWebhookTimestamp(String(NOW_SEC + 301), 'Polar')).toThrow(
      'Polar webhook timestamp outside tolerance'
    );
  });

  it('rejects a timestamp that is not a number', () => {
    expect(() => assertFreshWebhookTimestamp('soon', 'Polar')).toThrow(
      'Invalid Polar webhook timestamp'
    );
  });
});
