import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Auth emails: the templates escape the link, and without SMTP nothing is
 * sent and nothing throws (a warning says what was skipped).
 */

const mail = vi.hoisted(() => ({
  configured: false,
  send: vi.fn(async () => ({ id: 'm1' })),
}));
const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));

vi.mock('@server/lib/email', () => ({
  isEmailConfigured: () => mail.configured,
  sendEmail: mail.send,
}));
vi.mock('@server/lib/logger', () => ({ logger: log }));
const envMock = vi.hoisted(() => ({ NODE_ENV: 'production', MAGIC_LINK_ENABLED: true }));
vi.mock('@server/lib/env', () => ({ env: envMock }));

const { magicLinkAvailable, sendAuthEmail } = await import('@server/auth/email');
const { magicLinkEmail, resetPasswordEmail, verifyEmailEmail } = await import(
  '@server/emails/templates'
);

afterEach(() => {
  vi.clearAllMocks();
  mail.configured = false;
  envMock.MAGIC_LINK_ENABLED = true;
});

describe('magicLinkAvailable', () => {
  it('is on only when MAGIC_LINK_ENABLED and SMTP can deliver the link', () => {
    mail.configured = true;
    expect(magicLinkAvailable()).toBe(true);
    mail.configured = false;
    expect(magicLinkAvailable()).toBe(false);
    mail.configured = true;
    envMock.MAGIC_LINK_ENABLED = false;
    expect(magicLinkAvailable()).toBe(false);
  });
});

describe('auth email templates', () => {
  it.each([
    ['verification', verifyEmailEmail],
    ['password reset', resetPasswordEmail],
    ['magic link', magicLinkEmail],
  ])('%s: links the url, HTML-escaped', (_name, template) => {
    const { subject, html } = template({ url: 'https://app.test/x?a=1&b="2"' });
    expect(subject.length).toBeGreaterThan(0);
    expect(html).toContain('href="https://app.test/x?a=1&amp;b=&quot;2&quot;"');
    expect(html).not.toContain('b="2"');
  });
});

describe('sendAuthEmail', () => {
  it('without SMTP: sends nothing, does not throw, warns without the link outside development', async () => {
    await expect(
      sendAuthEmail('password reset', 'a@example.test', 'https://app.test/reset?token=secret')
    ).resolves.toBeUndefined();
    expect(mail.send).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls[0])).not.toContain('secret');
    expect(String(log.warn.mock.calls[0][1])).toMatch(/SMTP is not configured/);
  });

  it('with SMTP: sends the matching template to the user', async () => {
    mail.configured = true;
    await sendAuthEmail('magic link', 'a@example.test', 'https://app.test/m?token=t');
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'a@example.test',
        subject: expect.stringMatching(/sign-in link/),
      })
    );
  });

  it('an SMTP failure is logged, not thrown', async () => {
    mail.configured = true;
    mail.send.mockRejectedValueOnce(new Error('smtp down'));
    await expect(
      sendAuthEmail('verification', 'a@example.test', 'https://app.test/v')
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });
});
