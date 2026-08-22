import { type PlanId, plans } from '@shared/pricing';
import {
  IconArrowRight as ArrowRight,
  IconBuilding as Building2,
  IconCheck as Check,
  IconLoader2 as Loader2,
  IconUsers as Users,
} from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useAuth } from '@/components/auth/AuthProvider';
import { SEO } from '@/components/SEO';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useOrganizations } from '@/hooks/useOrganizations';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

const STEPS = [
  'onboarding.steps.profile',
  'onboarding.steps.organization',
  'onboarding.steps.plan',
] as const;

export default function Onboarding() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  async function completeOnboarding() {
    await supabase.auth.updateUser({
      data: { onboarding_completed: true },
    });
    navigate('/dashboard', { replace: true });
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-16">
      <SEO title={t('onboarding.getStarted')} />

      {/* Progress */}
      <div className="mb-8 flex items-center gap-2">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <div
              className={cn(
                'flex size-8 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                i < step
                  ? 'bg-primary text-primary-foreground'
                  : i === step
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
              )}
            >
              {i < step ? <Check className="size-4" /> : i + 1}
            </div>
            <span
              className={cn(
                'hidden text-sm sm:block',
                i === step ? 'font-medium text-foreground' : 'text-muted-foreground'
              )}
            >
              {t(label)}
            </span>
            {i < STEPS.length - 1 && <div className="h-px w-6 bg-border" />}
          </div>
        ))}
      </div>

      {/* Steps */}
      <div className="w-full max-w-lg">
        {step === 0 && (
          <ProfileStep
            defaultName={user?.user_metadata?.full_name || ''}
            onNext={() => setStep(1)}
          />
        )}
        {step === 1 && <OrgStep onNext={() => setStep(2)} onSkip={() => setStep(2)} />}
        {step === 2 && <PlanStep onNext={completeOnboarding} />}
      </div>
    </div>
  );
}

function ProfileStep({ defaultName, onNext }: { defaultName: string; onNext: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultName);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await supabase.auth.updateUser({ data: { full_name: name.trim() } });
    setSaving(false);
    onNext();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('onboarding.profile.title')}</CardTitle>
        <CardDescription>{t('onboarding.profile.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="name">{t('onboarding.profile.fullName')}</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('onboarding.profile.placeholder')}
              autoFocus
            />
          </div>
          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {t('common.continue')}
            <ArrowRight className="ml-2 size-4" />
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function OrgStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const { t } = useTranslation();
  const { createOrganization } = useOrganizations();
  const [orgName, setOrgName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!orgName.trim()) return;
    setSaving(true);
    setError('');
    try {
      await createOrganization(orgName.trim());
      onNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('onboarding.org.error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="size-5" />
          {t('onboarding.org.title')}
        </CardTitle>
        <CardDescription>{t('onboarding.org.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="orgName">{t('onboarding.org.nameLabel')}</Label>
            <Input
              id="orgName"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder={t('onboarding.org.placeholder')}
              autoFocus
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <div className="flex gap-3">
            <Button type="button" variant="ghost" onClick={onSkip} className="flex-1">
              {t('common.skipForNow')}
            </Button>
            <Button type="submit" className="flex-1" disabled={saving || !orgName.trim()}>
              {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {t('common.create')}
              <ArrowRight className="ml-2 size-4" />
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PlanStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<PlanId>('free');

  function handleContinue() {
    if (selected !== 'free') {
      // Redirect to billing to complete checkout, then they'll come back
      window.location.href = '/settings/billing';
      return;
    }
    onNext();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-5" />
          {t('onboarding.plan.title')}
        </CardTitle>
        <CardDescription>{t('onboarding.plan.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {plans.map((plan) => (
          <button
            key={plan.id}
            type="button"
            onClick={() => setSelected(plan.id)}
            className={cn(
              'flex w-full items-center justify-between rounded-lg border p-4 text-left transition-colors',
              selected === plan.id
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/50'
            )}
          >
            <div>
              <p className="font-semibold">{plan.name}</p>
              <p className="text-sm text-muted-foreground">{plan.description}</p>
            </div>
            <div className="text-right">
              <p className="font-bold">
                {plan.price.monthly === 0
                  ? t('common.free')
                  : `$${(plan.price.monthly / 100).toFixed(0)}/mo`}
              </p>
            </div>
          </button>
        ))}
        <Button onClick={handleContinue} className="w-full">
          {selected === 'free'
            ? t('onboarding.plan.continueWithFree')
            : t('onboarding.plan.continueToCheckout')}
          {selected === 'free' ? (
            <Check className="ml-2 size-4" />
          ) : (
            <ArrowRight className="ml-2 size-4" />
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
