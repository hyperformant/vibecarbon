import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * src/server/lib/email.ts: the SMTP sender. It builds its transporter once,
 * at import, from the env, so each case sets the env and then imports the
 * module afresh.
 */

const { env, sendMail, createTransport, logger } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return {
    env: {} as Record<string, string | number | undefined>,
    sendMail,
    createTransport: vi.fn(() => ({ sendMail })),
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@server/lib/env', () => ({ env }));
vi.mock('@server/lib/logger', () => ({ logger }));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

const SMTP = {
  SMTP_HOST: 'smtp.test.com',
  SMTP_USER: 'user',
  SMTP_PASS: 'pass',
  SMTP_ADMIN_EMAIL: 'noreply@test.com',
  SMTP_SENDER_NAME: 'TestApp',
};

async function emailWith(vars: Record<string, string | number | undefined>) {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, vars);
  vi.resetModules();
  return import('@server/lib/email');
}

const message = { to: 'user@test.com', subject: 'Test Email', html: '<h1>Hello</h1>' };

beforeEach(() => {
  sendMail.mockReset();
  createTransport.mockClear();
  logger.debug.mockClear();
  logger.info.mockClear();
  logger.error.mockClear();
});

describe('isEmailConfigured', () => {
  it('is true with a transporter (host and user) and an admin email', async () => {
    const { isEmailConfigured } = await emailWith(SMTP);
    expect(isEmailConfigured()).toBe(true);
  });

  it('is false with an admin email but no transporter', async () => {
    const { isEmailConfigured } = await emailWith({ SMTP_ADMIN_EMAIL: 'noreply@test.com' });
    expect(isEmailConfigured()).toBe(false);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('is false with a transporter but no admin email', async () => {
    const { isEmailConfigured } = await emailWith({ SMTP_HOST: 'smtp.test.com', SMTP_USER: 'user' });
    expect(isEmailConfigured()).toBe(false);
  });

  it('is false with neither', async () => {
    const { isEmailConfigured } = await emailWith({});
    expect(isEmailConfigured()).toBe(false);
  });
});

describe('sendEmail when not configured', () => {
  it('returns an empty result and sends nothing', async () => {
    const { sendEmail } = await emailWith({});
    expect(await sendEmail(message)).toEqual({});
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('logs at debug that the email was skipped', async () => {
    const { sendEmail } = await emailWith({});
    await sendEmail(message);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'user@test.com', subject: 'Test Email' }),
      'Email skipped (not configured)'
    );
  });

  it('skips when the admin email is set but there is no transporter', async () => {
    const { sendEmail } = await emailWith({ ...SMTP, SMTP_HOST: undefined });
    expect(await sendEmail(message)).toEqual({});
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('sendEmail when configured', () => {
  it('sends and returns the message id', async () => {
    sendMail.mockResolvedValue({ messageId: 'msg-123' });
    const { sendEmail } = await emailWith(SMTP);
    expect(await sendEmail(message)).toEqual({ id: 'msg-123' });
  });

  it('joins several recipients with a comma', async () => {
    sendMail.mockResolvedValue({ messageId: 'msg-1' });
    const { sendEmail } = await emailWith(SMTP);
    await sendEmail({ ...message, to: ['a@test.com', 'b@test.com'] });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@test.com, b@test.com' })
    );
  });

  it('passes a single recipient as it is', async () => {
    sendMail.mockResolvedValue({ messageId: 'msg-1' });
    const { sendEmail } = await emailWith(SMTP);
    await sendEmail({ ...message, to: 'single@test.com' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'single@test.com' }));
  });

  it('includes the plain-text body when given', async () => {
    sendMail.mockResolvedValue({ messageId: 'msg-1' });
    const { sendEmail } = await emailWith(SMTP);
    await sendEmail({ ...message, text: 'Plain text version' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: 'Plain text version' }));
  });

  it('includes replyTo when given', async () => {
    sendMail.mockResolvedValue({ messageId: 'msg-1' });
    const { sendEmail } = await emailWith(SMTP);
    await sendEmail({ ...message, replyTo: 'support@test.com' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 'support@test.com' }));
  });

  it('sends from "Name <address>" when a sender name is set', async () => {
    sendMail.mockResolvedValue({ messageId: 'msg-1' });
    const { sendEmail } = await emailWith(SMTP);
    await sendEmail(message);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'TestApp <noreply@test.com>' })
    );
  });

  it('sends from the bare address when no sender name is set', async () => {
    sendMail.mockResolvedValue({ messageId: 'msg-1' });
    const { sendEmail } = await emailWith({ ...SMTP, SMTP_SENDER_NAME: undefined });
    await sendEmail(message);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'noreply@test.com' }));
  });
});

describe('sendEmail when the send fails', () => {
  it('rethrows the transport error', async () => {
    sendMail.mockRejectedValue(new Error('Connection refused'));
    const { sendEmail } = await emailWith(SMTP);
    await expect(sendEmail(message)).rejects.toThrow('Connection refused');
  });

  it('logs the failure', async () => {
    sendMail.mockRejectedValue(new Error('Auth failed'));
    const { sendEmail } = await emailWith(SMTP);
    await expect(sendEmail(message)).rejects.toThrow('Auth failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'user@test.com', subject: 'Test Email' }),
      'Email send error'
    );
  });
});
