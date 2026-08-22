import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// `test_`-prefixed so the repo secret-scanner treats it as an obvious test
// fixture (not a real leaked secret) — the HMAC key value is arbitrary here.
const SECRET = 'test_pdl_webhook_secret';

vi.mock('@server/lib/env', () => ({
  env: { PADDLE_WEBHOOK_SECRET: SECRET, PADDLE_ENVIRONMENT: 'sandbox' },
}));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { PaddleProvider } = await import('@server/billing/providers/paddle');

const body = JSON.stringify({ event_type: 'subscription.created', data: { id: 'sub_1' } });

function sign(ts: number, payloadBody: string): string {
  const hash = createHmac('sha256', SECRET).update(`${ts}:${payloadBody}`).digest('hex');
  return `ts=${ts};h1=${hash}`;
}

describe('PaddleProvider webhook verification', () => {
  const provider = new PaddleProvider();

  it('accepts a validly signed, recent event', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const result = await provider.handleWebhook({ body, signature: sign(ts, body) });
    expect(result.type).toBe('subscription.created');
  });

  it('SECURITY: rejects a stale event outside the 5-minute tolerance (replay)', async () => {
    const staleTs = Math.floor(Date.now() / 1000) - 6 * 60; // 6 minutes old
    await expect(
      provider.handleWebhook({ body, signature: sign(staleTs, body) })
    ).rejects.toThrow(/timestamp outside tolerance/);
  });

  it('SECURITY: rejects a tampered signature', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const good = sign(ts, body);
    // Flip the last hex char of h1 to forge a mismatch of equal length.
    const tampered = good.replace(/.$/, (ch) => (ch === '0' ? '1' : '0'));
    await expect(
      provider.handleWebhook({ body, signature: tampered })
    ).rejects.toThrow(/Invalid Paddle webhook signature/);
  });

  it('rejects a signature computed over a different body', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sigForOtherBody = sign(ts, '{"event_type":"other"}');
    await expect(
      provider.handleWebhook({ body, signature: sigForOtherBody })
    ).rejects.toThrow(/Invalid Paddle webhook signature/);
  });
});
