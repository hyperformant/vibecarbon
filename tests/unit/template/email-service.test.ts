import { describe, expect, it, vi } from 'vitest';

/**
 * Tests for the email service logic.
 * Re-implements the pattern from carbon/src/server/lib/email.ts
 */

// ============================================================================
// LOGIC (mirror email.ts)
// ============================================================================

const mockLogger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };

interface MockTransporter {
  sendMail: (options: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text?: string;
    replyTo?: string;
  }) => Promise<{ messageId: string }>;
}

interface SmtpConfig {
  smtpHost?: string;
  smtpUser?: string;
  smtpPass?: string;
  smtpPort?: number;
  smtpAdminEmail?: string;
  smtpSenderName?: string;
}

function isEmailConfigured(config: SmtpConfig, transporter: MockTransporter | null): boolean {
  return transporter !== null && !!config.smtpAdminEmail;
}

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

async function sendEmail(
  options: SendEmailOptions,
  config: SmtpConfig,
  transporter: MockTransporter | null,
): Promise<{ id?: string }> {
  if (!isEmailConfigured(config, transporter) || !transporter || !config.smtpAdminEmail) {
    mockLogger.debug(
      { to: options.to, subject: options.subject },
      'Email skipped (not configured)',
    );
    return {};
  }

  const from = config.smtpSenderName
    ? `${config.smtpSenderName} <${config.smtpAdminEmail}>`
    : config.smtpAdminEmail;

  try {
    const info = await transporter.sendMail({
      from,
      to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
      subject: options.subject,
      html: options.html,
      ...(options.text ? { text: options.text } : {}),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    });

    mockLogger.info(
      { messageId: info.messageId, to: options.to, subject: options.subject },
      'Email sent',
    );
    return { id: info.messageId };
  } catch (error) {
    mockLogger.error({ error, to: options.to, subject: options.subject }, 'Email send error');
    throw error;
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('isEmailConfigured', () => {
  const mockTransporter: MockTransporter = {
    sendMail: vi.fn().mockResolvedValue({ messageId: 'test-id' }),
  };

  it('returns true when transporter exists and admin email is set', () => {
    expect(
      isEmailConfigured(
        { smtpHost: 'smtp.test.com', smtpUser: 'user', smtpAdminEmail: 'noreply@test.com' },
        mockTransporter,
      ),
    ).toBe(true);
  });

  it('returns false when transporter is null', () => {
    expect(isEmailConfigured({ smtpAdminEmail: 'noreply@test.com' }, null)).toBe(false);
  });

  it('returns false when admin email is missing', () => {
    expect(
      isEmailConfigured({ smtpHost: 'smtp.test.com', smtpUser: 'user' }, mockTransporter),
    ).toBe(false);
  });

  it('returns false when both are missing', () => {
    expect(isEmailConfigured({}, null)).toBe(false);
  });
});

describe('sendEmail', () => {
  const validConfig: SmtpConfig = {
    smtpHost: 'smtp.test.com',
    smtpUser: 'user',
    smtpPass: 'pass',
    smtpAdminEmail: 'noreply@test.com',
    smtpSenderName: 'TestApp',
  };
  const emailOptions: SendEmailOptions = {
    to: 'user@test.com',
    subject: 'Test Email',
    html: '<h1>Hello</h1>',
  };

  describe('when not configured', () => {
    it('returns empty object without sending', async () => {
      const result = await sendEmail(emailOptions, {}, null);
      expect(result).toEqual({});
    });

    it('logs debug message about skipping', async () => {
      mockLogger.debug.mockClear();
      await sendEmail(emailOptions, {}, null);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'user@test.com', subject: 'Test Email' }),
        'Email skipped (not configured)',
      );
    });

    it('skips when transporter is null', async () => {
      const result = await sendEmail(emailOptions, validConfig, null);
      expect(result).toEqual({});
    });
  });

  describe('when configured', () => {
    it('sends email successfully', async () => {
      const mockTransporter: MockTransporter = {
        sendMail: vi.fn().mockResolvedValue({ messageId: 'msg-123' }),
      };

      const result = await sendEmail(emailOptions, validConfig, mockTransporter);
      expect(result).toEqual({ id: 'msg-123' });
    });

    it('joins array recipients with comma', async () => {
      const mockTransporter: MockTransporter = {
        sendMail: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
      };

      await sendEmail(
        { ...emailOptions, to: ['a@test.com', 'b@test.com'] },
        validConfig,
        mockTransporter,
      );
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'a@test.com, b@test.com' }),
      );
    });

    it('passes single recipient as-is', async () => {
      const mockTransporter: MockTransporter = {
        sendMail: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
      };

      await sendEmail({ ...emailOptions, to: 'single@test.com' }, validConfig, mockTransporter);
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'single@test.com' }),
      );
    });

    it('includes optional text field', async () => {
      const mockTransporter: MockTransporter = {
        sendMail: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
      };

      await sendEmail(
        { ...emailOptions, text: 'Plain text version' },
        validConfig,
        mockTransporter,
      );
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Plain text version' }),
      );
    });

    it('includes optional replyTo field', async () => {
      const mockTransporter: MockTransporter = {
        sendMail: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
      };

      await sendEmail(
        { ...emailOptions, replyTo: 'support@test.com' },
        validConfig,
        mockTransporter,
      );
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ replyTo: 'support@test.com' }),
      );
    });

    it('builds from address with sender name', async () => {
      const mockTransporter: MockTransporter = {
        sendMail: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
      };

      await sendEmail(emailOptions, validConfig, mockTransporter);
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'TestApp <noreply@test.com>' }),
      );
    });

    it('uses bare email when sender name is not set', async () => {
      const mockTransporter: MockTransporter = {
        sendMail: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
      };

      const configNoName: SmtpConfig = { ...validConfig, smtpSenderName: undefined };
      await sendEmail(emailOptions, configNoName, mockTransporter);
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'noreply@test.com' }),
      );
    });
  });

  describe('error handling', () => {
    it('throws when sendMail rejects', async () => {
      const mockTransporter: MockTransporter = {
        sendMail: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };

      await expect(sendEmail(emailOptions, validConfig, mockTransporter)).rejects.toThrow(
        'Connection refused',
      );
    });

    it('logs error on sendMail failure', async () => {
      mockLogger.error.mockClear();
      const mockTransporter: MockTransporter = {
        sendMail: vi.fn().mockRejectedValue(new Error('Auth failed')),
      };

      try {
        await sendEmail(emailOptions, validConfig, mockTransporter);
      } catch {
        // expected
      }
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
