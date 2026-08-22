import {
  IconChartBar,
  IconCheck,
  IconCopy,
  IconCreditCard,
  IconKey,
  IconMail,
  IconPalette,
  IconRocket,
  IconSparkles,
} from '@tabler/icons-react';
import { type ComponentType, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { useDocsVisibility } from '@/hooks/api';
import { useSetupStatus } from '@/hooks/api/useSetupStatus';
import { isDocsHrefVisible } from '@/lib/docs-links';
import {
  commandForStep,
  type SetupIcon,
  type SetupIntegration,
  type SetupStep,
} from '@/lib/setup-progress';
import { cn } from '@/lib/utils';

const STEP_ICON: Record<SetupIcon, ComponentType<{ className?: string }>> = {
  sparkles: IconSparkles,
  paint: IconPalette,
  mail: IconMail,
  key: IconKey,
  chart: IconChartBar,
  card: IconCreditCard,
  rocket: IconRocket,
};

const isExternal = (url: string) => /^https?:\/\//.test(url);

function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(command).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1300);
      }}
      className={cn(
        'group/cmd bg-muted hover:border-primary flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 font-mono text-[11px] transition-colors',
        className
      )}
    >
      {copied ? (
        <span className="text-success flex-1 text-left">Copied to clipboard ✓</span>
      ) : (
        <>
          <span className="text-primary">$</span>
          <span className="text-foreground min-w-0 flex-1 truncate text-left">{command}</span>
        </>
      )}
      <IconCopy
        className={cn('size-3.5 shrink-0', copied ? 'text-success' : 'text-muted-foreground')}
      />
    </button>
  );
}

function StepNode({ step }: { step: SetupStep }) {
  return (
    <div
      className={cn(
        'relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full border-2 bg-muted',
        step.done && 'border-success bg-success text-background',
        step.current && 'border-primary text-primary shadow-[0_0_0_4px_var(--glow-primary)]',
        !step.done && !step.current && 'border-border text-muted-foreground'
      )}
    >
      {step.done ? (
        <IconCheck className="size-4" />
      ) : step.launch ? (
        <IconRocket className="size-4" />
      ) : step.current ? (
        <span className="bg-primary size-3 rounded-full shadow-[0_0_8px_var(--primary)]" />
      ) : (
        <span className="size-2 rounded-full bg-current opacity-45" />
      )}
    </div>
  );
}

function TimelineStep({ step, isLast }: { step: SetupStep; isLast: boolean }) {
  const partner = step.integrations?.find((i) => i.isPartner);
  return (
    <div className="relative grid grid-cols-[36px_1fr] gap-3.5 py-2.5">
      {!isLast && (
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-[18px] -bottom-[18px] left-[17px] z-0 w-0.5 rounded',
            step.done ? 'bg-primary' : 'bg-border'
          )}
        />
      )}
      <StepNode step={step} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {String(step.index).padStart(2, '0')}
          </span>
          <span className={cn('text-sm font-semibold', step.done && 'text-muted-foreground')}>
            {step.label}
          </span>
          {step.current && (
            <Badge className="h-4 px-1.5 text-[9.5px] tracking-wide uppercase">Next up</Badge>
          )}
          {step.launch && (
            <Badge
              variant="outline"
              className="text-primary border-primary h-4 px-1.5 text-[9.5px] tracking-wide uppercase"
            >
              Launch
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">{step.description}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2.5">
          <CopyCommand command={step.command} className="w-[320px] max-w-full" />
          {step.done ? (
            step.optedOut ? (
              <Badge variant="secondary" className="h-5 px-2 text-[10px]">
                Skipped
              </Badge>
            ) : (
              <span className="text-success text-xs">✓ Done</span>
            )
          ) : partner ? (
            <span className="text-foreground flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs">
              <span className="text-muted-foreground text-[10px] tracking-wide uppercase">Rec</span>
              {partner.name}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Spotlight({
  step,
  onSkipBilling,
  busy,
}: {
  step: SetupStep;
  onSkipBilling: () => void;
  busy: boolean;
}) {
  const Icon = STEP_ICON[step.icon];
  const integrations = step.integrations;
  const [provider, setProvider] = useState<string>(integrations?.[0]?.id ?? '');

  // Reset the selection when the spotlighted step changes.
  useEffect(() => {
    setProvider(integrations?.[0]?.id ?? '');
  }, [integrations]);

  const selected: SetupIntegration | undefined = integrations?.find((i) => i.id === provider);
  const command = commandForStep(step, integrations ? provider : undefined);
  const docsVisibility = useDocsVisibility();

  // Integrations without a hosted signup page (e.g. "Any SMTP") point their CTA
  // at an internal guide instead. With that documentation turned off the button
  // would lead nowhere, so it is dropped — the option itself stays, because the
  // configure command above is what actually does the work.
  const showCta = selected ? isDocsHrefVisible(selected.url, docsVisibility) : false;

  return (
    <aside className="border-border/80 relative self-start rounded-2xl border bg-[linear-gradient(160deg,var(--glow-primary),transparent_60%)] p-5">
      <div className="text-primary text-[10px] font-semibold tracking-[0.1em] uppercase">
        ◆ Next up · Step {step.index} of 7
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="bg-primary/15 text-primary flex size-11 items-center justify-center rounded-xl">
          <Icon className="size-5" />
        </div>
        <h3 className="text-lg font-bold tracking-tight">{step.label}</h3>
      </div>
      <p className="text-muted-foreground mt-3 text-sm">{step.spotlightDescription}</p>

      {integrations ? (
        <>
          <div className="text-muted-foreground mt-4 mb-2 text-[10px] font-semibold tracking-wide uppercase">
            Integrations
          </div>
          <RadioGroup
            value={provider}
            onValueChange={(v) => setProvider(String(v))}
            className="gap-2"
          >
            {integrations.map((int) => (
              <label
                key={int.id}
                htmlFor={`int-${int.id}`}
                className="border-input has-[[data-checked]]:border-ring has-[[data-checked]]:bg-accent flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors"
              >
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-extrabold"
                  style={{ background: int.logo.bg, color: int.logo.fg }}
                >
                  {int.logo.text}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{int.name}</span>
                    {int.isPartner && (
                      <Badge
                        variant="outline"
                        className="text-primary border-primary h-4 px-1.5 text-[9px] tracking-wide uppercase"
                      >
                        Partner
                      </Badge>
                    )}
                  </span>
                  <span className="text-muted-foreground block text-xs">{int.pitch}</span>
                </span>
                <RadioGroupItem value={int.id} id={`int-${int.id}`} />
              </label>
            ))}
          </RadioGroup>

          <CopyCommand command={command} className="mt-4 w-full" />

          {selected &&
            showCta &&
            (isExternal(selected.url) ? (
              <Button asChild className="mt-2.5 w-full">
                <a href={selected.url} target="_blank" rel="noopener noreferrer">
                  {selected.ctaLabel} →
                </a>
              </Button>
            ) : (
              <Button asChild className="mt-2.5 w-full">
                <Link to={selected.url}>{selected.ctaLabel} →</Link>
              </Button>
            ))}
        </>
      ) : (
        <>
          <CopyCommand command={step.command} className="mt-4 w-full" />
          {step.id === 'payments' && (
            <button
              type="button"
              onClick={onSkipBilling}
              disabled={busy}
              className="text-muted-foreground hover:text-foreground mt-3 block w-full text-center text-xs underline-offset-2 hover:underline disabled:opacity-50"
            >
              Not charging? Skip payments
            </button>
          )}
        </>
      )}
    </aside>
  );
}

export function SetupProgress() {
  const { progress, isLoading, isError, setBillingOptOut } = useSetupStatus();

  if (isLoading) {
    return (
      <Card className="glass">
        <CardHeader>
          <Skeleton className="h-5 w-40 rounded-md" />
          <Skeleton className="mt-3 h-2 w-full rounded-full" />
        </CardHeader>
      </Card>
    );
  }

  if (isError || !progress) return null;

  return (
    <Card className="glass relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 [background:radial-gradient(80%_120%_at_100%_0%,var(--glow-primary),transparent_55%)]" />
      <CardHeader className="relative">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardDescription className="text-xs font-medium tracking-wide uppercase">
              Setup progress
            </CardDescription>
            <CardTitle className="mt-2 text-[15px] font-medium">
              {progress.complete ? (
                <>You&rsquo;re all set. Ready for production 🚀</>
              ) : (
                <>
                  You&rsquo;re{' '}
                  <span className="text-primary font-bold">{progress.doneCount} steps</span> in,{' '}
                  <span className="text-primary font-bold">{progress.remaining} to launch</span> 🚀
                </>
              )}
            </CardTitle>
          </div>
          <div className="text-right leading-none">
            <div className="text-foreground text-3xl font-bold tracking-tight tabular-nums sm:text-4xl">
              {progress.percent}%
            </div>
            <div className="text-muted-foreground mt-1.5 text-xs tabular-nums">
              {progress.doneCount} / {progress.total} complete
            </div>
          </div>
        </div>
        <div className="bg-muted mt-3 h-2 w-full overflow-hidden rounded-full">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              progress.complete
                ? 'bg-success'
                : 'bg-[linear-gradient(90deg,var(--success),var(--primary))]'
            )}
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </CardHeader>

      <CardContent className="relative">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_366px] lg:gap-8">
          <div>
            {progress.steps.map((step, i) => (
              <TimelineStep key={step.id} step={step} isLast={i === progress.steps.length - 1} />
            ))}
          </div>
          {progress.current && (
            <Spotlight
              step={progress.current}
              busy={setBillingOptOut.isPending}
              onSkipBilling={() => setBillingOptOut.mutate(true)}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
