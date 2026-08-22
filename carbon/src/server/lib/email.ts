import nodemailer from 'nodemailer';
import { env } from './env';
import { logger } from './logger';

/**
 * Email service using SMTP (shared credentials with Supabase Auth).
 * Gracefully no-ops when not configured (matching isStripeConfigured() pattern).
 */

const transporter =
  env.SMTP_HOST && env.SMTP_USER
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT ?? 587,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      })
    : null;

export function isEmailConfigured(): boolean {
  return transporter !== null && !!env.SMTP_ADMIN_EMAIL;
}

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

/**
 * Send an email via SMTP.
 * No-ops if email is not configured (dev mode without SMTP credentials).
 */
export async function sendEmail(options: SendEmailOptions): Promise<{ id?: string }> {
  if (!isEmailConfigured() || !transporter || !env.SMTP_ADMIN_EMAIL) {
    logger.debug({ to: options.to, subject: options.subject }, 'Email skipped (not configured)');
    return {};
  }

  const from = env.SMTP_SENDER_NAME
    ? `${env.SMTP_SENDER_NAME} <${env.SMTP_ADMIN_EMAIL}>`
    : env.SMTP_ADMIN_EMAIL;

  try {
    const info = await transporter.sendMail({
      from,
      to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
      subject: options.subject,
      html: options.html,
      ...(options.text ? { text: options.text } : {}),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    });

    logger.info(
      { messageId: info.messageId, to: options.to, subject: options.subject },
      'Email sent'
    );
    return { id: info.messageId };
  } catch (error) {
    logger.error({ error, to: options.to, subject: options.subject }, 'Email send error');
    throw error;
  }
}
