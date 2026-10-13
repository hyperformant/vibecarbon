import { magicLinkEmail, resetPasswordEmail, verifyEmailEmail } from '../emails/templates';
import { isEmailConfigured, sendEmail } from '../lib/email';
import { env } from '../lib/env';
import { logger } from '../lib/logger';

/**
 * Auth emails (verification, password reset, magic link) through the app's
 * SMTP mailer.
 *
 * Without SMTP the auth instance does not require email verification, and
 * these log a warning instead of sending, so sign-up and sign-in still work
 * in a fresh project. In development the warning includes the link, since
 * nothing else can deliver it; elsewhere it never does (the link is a
 * one-time credential).
 *
 * A send failure is logged, never thrown: the endpoints answer the same
 * whether or not an account exists, and an SMTP error must not change that.
 */

type AuthEmailKind = 'verification' | 'password reset' | 'magic link';

const TEMPLATES: Record<AuthEmailKind, (p: { url: string }) => { subject: string; html: string }> =
  {
    verification: verifyEmailEmail,
    'password reset': resetPasswordEmail,
    'magic link': magicLinkEmail,
  };

export async function sendAuthEmail(kind: AuthEmailKind, to: string, url: string): Promise<void> {
  if (!isEmailConfigured()) {
    logger.warn(
      env.NODE_ENV === 'development' ? { kind, to, url } : { kind, to },
      `SMTP is not configured, so the ${kind} email was not sent. Set SMTP_* (vibecarbon configure) to deliver auth emails.`
    );
    return;
  }
  const { subject, html } = TEMPLATES[kind]({ url });
  try {
    await sendEmail({ to, subject, html });
  } catch {
    // sendEmail already logged the SMTP error.
    logger.error({ kind, to }, `The ${kind} email could not be sent`);
  }
}
