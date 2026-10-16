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
import { type ComponentType, useState } from 'react';
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
  type SetupStepId,
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

/**
 * Geometry of one timeline row, all in spacing units so it scales with the root
 * font size (18px here; mixing rem-sized nodes with px columns pushed the node
 * 4.5px wider than its column and 2px right of the connector):
 * - the node is `size-9` in a `--spacing(9)` column, so its centre sits at
 *   `4.5`; the connector is centred there with `-translate-x-1/2`;
 * - the title line is `5` tall (`text-sm`), so the node is pulled up by half the
 *   difference (`-mt-2`) to put its centre on the title's centre;
 * - the connector runs from this node's bottom edge (`py-2.5 - 2 + 9 = 9.5`) to
 *   the next node's top edge (`-bottom-0.5`), never behind the nodes, whose
 *   fills are translucent.
 * Rows carry `px-2` of padding, hence `left-6.5`.
 */
const CONNECTOR = 'top-9.5 -bottom-0.5 left-6.5 w-0.5 -translate-x-1/2';

interface StepNodeProps {
  step: SetupStep;
  selected: boolean;
}

/**
 * The step's circle carries every interaction state, so the row itself stays
 * unhighlighted:
 * - current: primary border plus a soft 4px glow (unchanged);
 * - hovered: a faint primary ring set off from the circle by a 2px gap, a
 *   cue that the step is clickable (pure CSS: hovering anywhere on the row
 *   hovers the step button's overlay, and the button is the `group/step`);
 * - selected: the same ring at full strength, which wins over hover;
 * - keyboard focus: an outline outside the ring.
 * Ring, offset and glow are composed box-shadows; on a current step that is
 * also hovered or selected the glow widens to 8px so it shows past the ring.
 */
function StepNode({ step, selected }: StepNodeProps) {
  return (
    <span
      data-selected={selected || undefined}
      className={cn(
        'relative z-10 -mt-2 flex size-9 shrink-0 items-center justify-center rounded-full border-2 bg-muted transition-shadow',
        'ring-offset-card outline-ring group-focus-visible/step:outline-2 group-focus-visible/step:outline-offset-[6px]',
        // `text-background` is transparent in this theme (the canvas shows
        // through), which hid the check, so done nodes use primary-foreground.
        step.done && 'border-success bg-success text-primary-foreground',
        step.current && 'border-primary text-primary shadow-[0_0_0_4px_var(--glow-primary)]',
        // A ring would cover the 4px glow, so push the glow out past it.
        step.current &&
          (selected
            ? 'shadow-[0_0_0_8px_var(--glow-primary)]'
            : 'group-hover/step:shadow-[0_0_0_8px_var(--glow-primary)]'),
        !step.done && !step.current && 'border-border text-muted-foreground',
        selected
          ? 'ring-primary ring-2 ring-offset-2'
          : 'group-hover/step:ring-primary/45 group-hover/step:ring-2 group-hover/step:ring-offset-2'
      )}
    >
      {step.done ? (
        <IconCheck className="size-4" stroke={3} />
      ) : step.launch ? (
        <IconRocket className="size-4" />
      ) : step.current ? (
        <span className="bg-primary size-3 rounded-full shadow-[0_0_8px_var(--primary)]" />
      ) : (
        <span className="size-2 rounded-full bg-current opacity-45" />
      )}
    </span>
  );
}

interface TimelineStepProps {
  step: SetupStep;
  isLast: boolean;
  selected: boolean;
  onSelect: (id: SetupStepId) => void;
}

function TimelineStep({ step, isLast, selected, onSelect }: TimelineStepProps) {
  const partner = step.integrations?.find((i) => i.isPartner);
  return (
    // The step button is the row's only control. Its ::after overlay is
    // stretched over the whole row (`relative` here, `after:inset-0` there),
    // so the click area covers the title, description, command area and
    // circle, padding included. Only the copy button is lifted above the
    // overlay. The row has no background or pointer cursor of its own (the
    // normal arrow throughout); hover, selection and focus show on the circle.
    // Hover never changes the Spotlight panel; only a click or Enter/Space does.
    <div className="relative px-2 py-2.5">
      {!isLast && (
        <span
          aria-hidden="true"
          className={cn('absolute z-0 rounded', CONNECTOR, step.done ? 'bg-primary' : 'bg-border')}
        />
      )}
      <button
        type="button"
        aria-pressed={selected}
        aria-current={step.current ? 'step' : undefined}
        aria-controls="setup-spotlight"
        onClick={() => onSelect(step.id)}
        className="group/step grid w-full cursor-default grid-cols-[--spacing(9)_1fr] gap-3.5 text-left outline-none after:absolute after:inset-0 after:z-20 after:content-['']"
      >
        <StepNode step={step} selected={selected} />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
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
          </span>
          <span className="text-muted-foreground mt-0.5 block text-xs">{step.description}</span>
        </span>
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-2.5 pl-12.5">
        {/* Above the overlay: copying does not select the step. */}
        <CopyCommand command={step.command} className="relative z-30 w-[320px] max-w-full" />
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
  );
}

/** Spotlight eyebrow: what this step is relative to the journey. */
function spotlightEyebrow(step: SetupStep, total: number): string {
  const position = `Step ${step.index} of ${total}`;
  if (step.current) return `◆ Next up · ${position}`;
  if (step.optedOut) return `Skipped · ${position}`;
  if (step.done) return `✓ Done · ${position}`;
  return position;
}

// Rendered with `key={step.id}`, so the provider choice starts fresh for every
// step the operator selects.
function Spotlight({
  step,
  total,
  onSkipBilling,
  busy,
}: {
  step: SetupStep;
  total: number;
  onSkipBilling: () => void;
  busy: boolean;
}) {
  const Icon = STEP_ICON[step.icon];
  const integrations = step.integrations;
  const [provider, setProvider] = useState<string>(integrations?.[0]?.id ?? '');

  const selected: SetupIntegration | undefined = integrations?.find((i) => i.id === provider);
  const command = commandForStep(step, integrations ? provider : undefined);
  const docsVisibility = useDocsVisibility();

  // Integrations without a hosted signup page (e.g. "Any SMTP") point their CTA
  // at an internal guide instead. With that documentation turned off the button
  // would lead nowhere, so it is dropped — the option itself stays, because the
  // configure command above is what actually does the work.
  const showCta = selected ? isDocsHrefVisible(selected.url, docsVisibility) : false;

  return (
    <aside
      id="setup-spotlight"
      aria-live="polite"
      aria-label={`${step.label} setup`}
      className="border-border/80 relative self-start rounded-2xl border bg-[linear-gradient(160deg,var(--glow-primary),transparent_60%)] p-5"
    >
      <div
        data-testid="spotlight-eyebrow"
        className={cn(
          'text-[10px] font-semibold tracking-[0.1em] uppercase',
          step.current ? 'text-primary' : step.done ? 'text-success' : 'text-muted-foreground'
        )}
      >
        {spotlightEyebrow(step, total)}
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
          {step.id === 'payments' && !step.done && (
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
  // `null` follows the current step, so the panel advances as steps complete
  // until the operator picks one explicitly.
  const [selectedId, setSelectedId] = useState<SetupStepId | null>(null);

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

  // With every step complete there is no current step: default to the deploy
  // finale so the panel, and step browsing, stay available.
  const defaultId = progress.current?.id ?? 'deploy';
  const activeId = selectedId ?? defaultId;
  const spotlightStep = progress.steps.find((s) => s.id === activeId) ?? progress.steps[0];

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
          <div className="-mx-2">
            {progress.steps.map((step, i) => (
              <TimelineStep
                key={step.id}
                step={step}
                isLast={i === progress.steps.length - 1}
                selected={step.id === activeId}
                onSelect={setSelectedId}
              />
            ))}
          </div>
          {spotlightStep && (
            <Spotlight
              key={spotlightStep.id}
              step={spotlightStep}
              total={progress.total}
              busy={setBillingOptOut.isPending}
              onSkipBilling={() => setBillingOptOut.mutate(true)}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
