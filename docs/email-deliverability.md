# Email deliverability

Your Vibecarbon app sends transactional email in two ways, and **neither works
until you configure SMTP**:

1. **Auth email via GoTrue**: signup confirmation, magic links, password reset,
   and email-change confirmation. Sent by the Supabase auth service.
2. **App email via the server mailer**: organization invites, subscription
   receipts, contact-form notifications, newsletters (`src/server/lib/email.ts`).

## Why this matters before launch

- **SMTP defaults to empty** (`SMTP_HOST=""` in `.env.example`). With no SMTP
  host configured:
  - The **app mailer silently no-ops**: invites and notifications simply never
    arrive, with no error surfaced to the user.
  - **GoTrue password-reset and magic-link email fail**: users who forget their
    password cannot recover their account.
- Local development sets `GOTRUE_MAILER_AUTOCONFIRM=true`, so signups are
  auto-confirmed and you never notice email is unconfigured. **In production you
  should turn autoconfirm off** (`vibecarbon configure`), which then *requires*
  working SMTP. Otherwise no one can complete signup.

## Configure SMTP

Run `vibecarbon configure` and choose the email/SMTP option, or set these in
your environment (`.env.local` for local, GitHub Environment secrets for CI
deploys):

```
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_ADMIN_EMAIL=admin@yourdomain.com     # GoTrue sender
SMTP_SENDER_NAME="Your App"
```

Any standards-compliant provider works (e.g. Amazon SES, Postmark, Resend,
SendGrid, Mailgun, or your own postfix). Prefer a transactional-email provider
over a mailbox provider (Gmail/Microsoft 365): they are built for this, give you
DKIM signing, and won't rate-limit or flag you.

## Deliverability: SPF, DKIM, DMARC (do not skip this)

A correctly configured SMTP relay whose **domain authentication is missing** will
send mail that lands in spam, which silently breaks signup confirmation and
password reset for real users. Configure all three DNS records for your sending
domain:

- **SPF**: a `TXT` record on your domain authorizing your provider's servers,
  e.g. `v=spf1 include:amazonses.com ~all` (use your provider's include).
- **DKIM**: the `CNAME`/`TXT` records your provider gives you so outgoing mail
  is cryptographically signed. Every serious provider has a one-click setup that
  outputs the records to add.
- **DMARC**: a `TXT` record at `_dmarc.yourdomain.com`, e.g.
  `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` to start (monitor), then
  tighten to `p=quarantine`/`p=reject` once SPF+DKIM pass consistently.

Use your provider's domain-verification wizard: it prints the exact records.

## Verify it works before you rely on it

1. After `vibecarbon configure`, send yourself a test (the configure flow offers
   a test send; or trigger a password reset from the login page).
2. Check the message **arrives in the inbox, not spam**.
3. Inspect the received message headers for `SPF=pass`, `DKIM=pass`, and
   `DMARC=pass` (Gmail: "Show original").

If any of the three fail, fix the DNS record before launch: a confirmation
email in the spam folder is indistinguishable, to your users, from a broken
signup flow.
