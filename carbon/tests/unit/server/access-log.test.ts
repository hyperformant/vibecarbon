import { Hono } from 'hono';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { accessLog, redactPath } from '@server/middleware/access-log';

function capture() {
  const lines: string[] = [];
  const log = pino({ level: 'info' }, { write: (s: string) => void lines.push(s) });
  const app = new Hono();
  app.use('*', accessLog(log));
  app.all('*', (c) => c.text('ok'));
  return { app, lines };
}

describe('accessLog', () => {
  it.each([
    '/api/auth/reset-password/T0K3NT0K3NT0K3NT0K3NT0K3NT0K3N12?callbackURL=x',
    '/reset-password?token=T0K3N',
    '/api/auth/magic-link/verify?token=T0K3N',
    '/api/auth/callback/google?code=T0K3N&state=S',
  ])('never logs a token from %s', async (url) => {
    const { app, lines } = capture();
    await app.request(url);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('T0K3N');
    expect(lines[0]).not.toContain('state=');
    expect(lines[0]).not.toContain('?');
  });

  it('logs method, path, status and ms', async () => {
    const { app, lines } = capture();
    await app.request('/api/health?x=1');
    const rec = JSON.parse(lines[0]);
    expect(rec).toMatchObject({ method: 'GET', path: '/api/health', status: 200 });
    expect(typeof rec.ms).toBe('number');
  });
});

describe('redactPath', () => {
  it('redacts the segment after reset-password and verify-email', () => {
    expect(redactPath('/api/auth/reset-password/abc')).toBe('/api/auth/reset-password/[redacted]');
    expect(redactPath('/verify-email/abc/more')).toBe('/verify-email/[redacted]/more');
  });
  it('redacts any long url-safe segment', () => {
    expect(redactPath(`/x/${'a'.repeat(32)}`)).toBe('/x/[redacted]');
    expect(redactPath(`/x/${'a'.repeat(31)}`)).toBe(`/x/${'a'.repeat(31)}`);
  });
  it('leaves ordinary paths alone', () => {
    expect(redactPath('/api/orgs/members')).toBe('/api/orgs/members');
  });
});
