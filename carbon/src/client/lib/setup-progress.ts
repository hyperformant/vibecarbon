/**
 * Setup-progress model for the super-admin Overview.
 *
 * A gamified 7-step launch journey: Create → Customize → Email → Social logins
 * → Analytics → Payments → Deploy. Create and Customize are inherently done
 * (you can't be viewing this without having created and booted the app), so the
 * journey opens non-zero. The remaining steps flip to done from runtime
 * detection (see server/routes/v1/setup.ts).
 *
 * Steps that have an integration partner today (Email → Resend, Analytics →
 * Plausible) carry a provider list; the current-step spotlight turns that into a
 * picker whose selection parameterizes the `vibecarbon configure <feature>
 * <provider>` command and points a signup button at the chosen provider.
 */

export interface SetupFlags {
  /** SMTP configured. */
  email: boolean;
  /** At least one OAuth provider enabled. */
  oauth: boolean;
  /** Web analytics (Plausible) configured. */
  analytics: boolean;
  /** A billing provider is configured. */
  payments: boolean;
  /** Running in a deployed production environment. */
  deployed: boolean;
  /** Operator opted out of charging — completes the payments step. */
  billingOptOut: boolean;
}

export type SetupStepId =
  | 'create'
  | 'customize'
  | 'email'
  | 'oauth'
  | 'analytics'
  | 'payments'
  | 'deploy';

/** Icon key resolved to a Tabler icon in the component. */
export type SetupIcon = 'sparkles' | 'paint' | 'mail' | 'key' | 'chart' | 'card' | 'rocket';

export interface SetupIntegration {
  /** Provider flag passed to the CLI, e.g. `resend`. */
  id: string;
  name: string;
  pitch: string;
  isPartner?: boolean;
  /** External signup/docs URL for the CTA. */
  url: string;
  /** CTA label once selected. */
  ctaLabel: string;
  logo: { text: string; bg: string; fg: string };
}

export interface SetupStep {
  id: SetupStepId;
  index: number;
  label: string;
  description: string;
  spotlightDescription: string;
  icon: SetupIcon;
  /** Base command (no provider). */
  command: string;
  done: boolean;
  current: boolean;
  /** True only for the payments step when the operator opted out. */
  optedOut?: boolean;
  /** The deploy finale. */
  launch?: boolean;
  /** Present only for steps with a provider picker (email, analytics). */
  integrations?: SetupIntegration[];
}

export interface SetupProgress {
  steps: SetupStep[];
  percent: number;
  doneCount: number;
  remaining: number;
  total: number;
  complete: boolean;
  /** First incomplete step, or null when everything is done. */
  current: SetupStep | null;
}

const EMAIL_INTEGRATIONS: SetupIntegration[] = [
  {
    id: 'resend',
    name: 'Resend',
    pitch: '3,000 emails/mo free · 5-min setup',
    isPartner: true,
    url: 'https://resend.com/signup',
    ctaLabel: 'Create your Resend account',
    logo: { text: 'R', bg: '#000000', fg: '#ffffff' },
  },
  {
    id: 'postmark',
    name: 'Postmark',
    pitch: 'Fast, reliable transactional email',
    url: 'https://account.postmarkapp.com/sign_up',
    ctaLabel: 'Create your Postmark account',
    logo: { text: 'P', bg: '#ffdd00', fg: '#111111' },
  },
  {
    id: 'sendgrid',
    name: 'SendGrid',
    pitch: 'Scales to high volume',
    url: 'https://signup.sendgrid.com/',
    ctaLabel: 'Create your SendGrid account',
    logo: { text: 'S', bg: '#1a82e2', fg: '#ffffff' },
  },
  {
    id: 'smtp',
    name: 'Any SMTP',
    pitch: 'Bring your own mail server',
    url: '/docs/email',
    ctaLabel: 'Read the SMTP guide',
    logo: { text: '⚙', bg: 'var(--chip, #2a2a2a)', fg: 'var(--muted-foreground)' },
  },
];

const ANALYTICS_INTEGRATIONS: SetupIntegration[] = [
  {
    id: 'plausible',
    name: 'Plausible',
    pitch: 'Privacy-friendly, cookie-free analytics',
    isPartner: true,
    url: 'https://plausible.io/register',
    ctaLabel: 'Create your Plausible account',
    logo: { text: 'P', bg: '#5850ec', fg: '#ffffff' },
  },
];

interface StepDef {
  id: SetupStepId;
  label: string;
  description: string;
  spotlightDescription: string;
  icon: SetupIcon;
  command: string;
  integrations?: SetupIntegration[];
  launch?: boolean;
  done: (f: SetupFlags) => boolean;
  optedOut?: (f: SetupFlags) => boolean;
}

const STEP_DEFS: StepDef[] = [
  {
    id: 'create',
    label: 'Create',
    description: 'Scaffold your app from the starter',
    spotlightDescription: 'Scaffold a new app from the starter.',
    icon: 'sparkles',
    command: 'vibecarbon create my-app',
    done: () => true,
  },
  {
    id: 'customize',
    label: 'Customize',
    description: 'Boot it up, then brand & theme',
    spotlightDescription: 'Boot the full stack locally, then make it yours.',
    icon: 'paint',
    command: 'vibecarbon up',
    done: () => true,
  },
  {
    id: 'email',
    label: 'Email',
    description: 'Password resets & transactional email',
    spotlightDescription:
      'Wire up SMTP so your users can confirm their address, reset passwords, and receive receipts. Required before you go live.',
    icon: 'mail',
    command: 'vibecarbon configure email',
    integrations: EMAIL_INTEGRATIONS,
    done: (f) => f.email,
  },
  {
    id: 'oauth',
    label: 'Social logins',
    description: 'One-click sign-in for your users',
    spotlightDescription: 'Let users sign in with Google or Microsoft.',
    icon: 'key',
    command: 'vibecarbon configure oauth',
    done: (f) => f.oauth,
  },
  {
    id: 'analytics',
    label: 'Analytics',
    description: 'Privacy-friendly usage insights',
    spotlightDescription: 'Add privacy-friendly, cookie-free web analytics.',
    icon: 'chart',
    command: 'vibecarbon configure analytics',
    integrations: ANALYTICS_INTEGRATIONS,
    done: (f) => f.analytics,
  },
  {
    id: 'payments',
    label: 'Payments',
    description: 'Subscriptions & one-time checkout',
    spotlightDescription: 'Take subscriptions and one-time payments.',
    icon: 'card',
    command: 'vibecarbon configure payments',
    done: (f) => f.payments || f.billingOptOut,
    optedOut: (f) => f.billingOptOut,
  },
  {
    id: 'deploy',
    label: 'Deploy',
    description: 'Go live with SSL, backups & DNS handled',
    spotlightDescription: 'Ship it: SSL, backups, and DNS are handled for you.',
    icon: 'rocket',
    command: 'vibecarbon deploy',
    launch: true,
    done: (f) => f.deployed,
  },
];

export function buildSetupProgress(flags: SetupFlags): SetupProgress {
  let currentAssigned = false;
  const steps: SetupStep[] = STEP_DEFS.map((def, i) => {
    const done = def.done(flags);
    const current = !done && !currentAssigned;
    if (current) currentAssigned = true;
    return {
      id: def.id,
      index: i + 1,
      label: def.label,
      description: def.description,
      spotlightDescription: def.spotlightDescription,
      icon: def.icon,
      command: def.command,
      done,
      current,
      optedOut: def.optedOut?.(flags),
      launch: def.launch,
      integrations: def.integrations,
    };
  });

  const total = steps.length;
  const doneCount = steps.filter((s) => s.done).length;
  const percent = Math.round((doneCount / total) * 100);
  const current = steps.find((s) => s.current) ?? null;

  return {
    steps,
    percent,
    doneCount,
    remaining: total - doneCount,
    total,
    complete: doneCount === total,
    current,
  };
}

/**
 * The copy-command for a step, with an optional provider appended to a
 * `vibecarbon configure <feature>` command (non-configure commands are
 * returned unchanged).
 */
export function commandForStep(step: SetupStep, provider?: string): string {
  if (provider && step.command.startsWith('vibecarbon configure ')) {
    return `${step.command} ${provider}`;
  }
  return step.command;
}
