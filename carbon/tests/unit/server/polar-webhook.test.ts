import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// Polar secrets are base64, prefixed with "whsec_".
const SECRET_RAW = Buffer.from('polar_test_webhook_secret').toString('base64');
const SECRET = `whsec_${SECRET_RAW}`;

vi.mock('@server/lib/env', () => ({
  env: { POLAR_WEBHOOK_SECRET: SECRET, POLAR_ENVIRONMENT: 'sandbox' },
}));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { PolarProvider } = await import('@server/billing/providers/polar');

const body = JSON.stringify({ type: 'subscription.created', data: { id: 'sub_1' } });
const WEBHOOK_ID = 'msg_1';

// Mirror the combined header the billing webhook route builds:
// `${webhookId}.${timestamp}.v1,${signature}`
function sign(ts: number, payloadBody: string): string {
  const secretBytes = Buffer.from(SECRET_RAW, 'base64');
  const sig = createHmac('sha256', secretBytes)
    .update(`${WEBHOOK_ID}.${ts}.${payloadBody}`)
    .digest('base64');
  return `${WEBHOOK_ID}.${ts}.v1,${sig}`;
}

describe('PolarProvider webhook verification', () => {
  const provider = new PolarProvider();

  it('accepts a validly signed, recent event', async () => {
    const ts = Math.floor(Date.now() / 1000);
    await expect(
      provider.handleWebhook({ body, signature: sign(ts, body) })
    ).resolves.toBeDefined();
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
    const tampered = good.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
    await expect(
      provider.handleWebhook({ body, signature: tampered })
    ).rejects.toThrow(/Invalid Polar webhook signature/);
  });

  it('rejects a signature computed over a different body', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sigForOtherBody = sign(ts, '{"type":"other"}');
    await expect(
      provider.handleWebhook({ body, signature: sigForOtherBody })
    ).rejects.toThrow(/Invalid Polar webhook signature/);
  });
});
