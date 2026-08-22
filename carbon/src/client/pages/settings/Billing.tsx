import { formatPlanPrice, type Plan, type PlanId, plans } from '@shared/pricing';
import {
  IconAlertCircle as AlertCircle,
  IconCheck as Check,
  IconCreditCard as CreditCard,
  IconExternalLink as ExternalLink,
  IconLoader2 as Loader2,
  IconX as X,
} from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/components/auth/AuthProvider';
import { PageHeader } from '@/components/PageHeader';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiJson } from '@/lib/api';
import { ContentPanel } from '../../components/ContentPanel';

interface BillingStatus {
  configured: boolean;
}

interface PricesResponse {
  configured: boolean;
  plans: (Plan & {
    stripePriceIds: { monthly?: string } | null;
  })[];
}

interface Subscription {
  id: string;
  status: string;
  priceId: string;
  planId: PlanId;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  product: {
    id: string;
    name: string;
    description?: string;
  };
  price: {
    id: string;
    unitAmount: number;
    currency: string;
    interval: string;
  };
}

interface SubscriptionResponse {
  subscription: Subscription | null;
  status: string;
}

export async function fetchBillingStatus(): Promise<BillingStatus> {
  return apiJson<BillingStatus>('/api/v1/billing/status', {}, 'Failed to fetch billing status');
}

async function fetchPrices(): Promise<PricesResponse> {
  return apiJson<PricesResponse>('/api/v1/billing/prices', {}, 'Failed to fetch prices');
}

async function fetchSubscription(): Promise<SubscriptionResponse> {
  return apiJson<SubscriptionResponse>(
    '/api/v1/billing/subscription?type=user',
    {},
    'Failed to fetch subscription'
  );
}

async function createCheckout(priceId: string): Promise<{ url: string }> {
  return apiJson<{ url: string }>(
    '/api/v1/billing/checkout',
    { method: 'POST', body: { priceId, type: 'user' } },
    'Failed to create checkout'
  );
}

async function createSetupSession(): Promise<{ url: string }> {
  return apiJson<{ url: string }>(
    '/api/v1/billing/setup',
    { method: 'POST', body: { type: 'user' } },
    'Failed to create setup session'
  );
}

async function createPortalSession(): Promise<{ url: string }> {
  return apiJson<{ url: string }>(
    '/api/v1/billing/portal',
    { method: 'POST', body: { type: 'user' } },
    'Failed to create portal session'
  );
}

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export default function Billing() {
  const { t } = useTranslation();
  const { session } = useAuth();

  const { data: billingStatus, isLoading: isLoadingStatus } = useQuery({
    queryKey: ['billing-status'],
    queryFn: fetchBillingStatus,
    enabled: !!session,
  });

  const { data: pricesData } = useQuery({
    queryKey: ['billing-prices'],
    queryFn: fetchPrices,
    enabled: !!session,
  });

  const { data: subscriptionData, isLoading: isLoadingSubscription } = useQuery({
    queryKey: ['subscription'],
    queryFn: fetchSubscription,
    enabled: !!session && billingStatus?.configured,
  });

  const checkoutMutation = useMutation({
    mutationFn: createCheckout,
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const portalMutation = useMutation({
    mutationFn: createPortalSession,
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const setupMutation = useMutation({
    mutationFn: createSetupSession,
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const isLoading = isLoadingStatus || isLoadingSubscription;
  const subscription = subscriptionData?.subscription;
  const hasActiveSubscription =
    subscription && (subscription.status === 'active' || subscription.status === 'trialing');
  const currentPlanId: PlanId = subscription?.planId ?? 'free';

  type DisplayPlan = Plan & { stripePriceIds?: { monthly?: string } | null };
  const displayPlans: DisplayPlan[] = pricesData?.plans ?? plans;

  function getPriceId(plan: DisplayPlan): string | undefined {
    return plan.stripePriceIds?.monthly;
  }

  return (
    <>
      <PageHeader title={t('billing.title')} description={t('billing.description')} />

      <ContentPanel variant="narrow">
        {!billingStatus?.configured && !isLoadingStatus && (
          <Alert>
            <AlertCircle className="size-4" />
            <AlertDescription>
              Billing is not configured. Set{' '}
              <code className="bg-muted px-1 rounded">STRIPE_SECRET_KEY</code> and{' '}
              <code className="bg-muted px-1 rounded">STRIPE_WEBHOOK_SECRET</code> in your
              environment to enable billing.
            </AlertDescription>
          </Alert>
        )}

        {/* Current subscription status */}
        {hasActiveSubscription && (
          <Card>
            <CardHeader>
              <CardTitle>{t('billing.currentPlan')}</CardTitle>
              <CardDescription>
                You are on the{' '}
                <span className="font-semibold text-foreground">{subscription.product.name}</span>{' '}
                plan.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-semibold">{subscription.product.name}</p>
                    {subscription.status === 'trialing' && (
                      <Badge variant="secondary">{t('billing.trial')}</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {formatCurrency(subscription.price.unitAmount, subscription.price.currency)}/
                    {subscription.price.interval}
                  </p>
                  {subscription.cancelAtPeriodEnd && (
                    <p className="text-sm text-warning mt-1">
                      {t('billing.cancelsOn', {
                        date: formatDate(subscription.currentPeriodEnd),
                      })}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  onClick={() => portalMutation.mutate()}
                  disabled={portalMutation.isPending}
                >
                  {portalMutation.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <ExternalLink className="mr-2 size-4" />
                  )}
                  {t('common.manage')}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                {subscription.cancelAtPeriodEnd
                  ? 'Your subscription will end on '
                  : 'Next billing date: '}
                {formatDate(subscription.currentPeriodEnd)}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Plan selection */}
        <Card>
          <CardHeader>
            <CardTitle>
              {hasActiveSubscription ? t('billing.changePlan') : t('billing.choosePlan')}
            </CardTitle>
            <CardDescription>
              {hasActiveSubscription
                ? t('billing.changePlanDescription')
                : t('billing.choosePlanDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {/* Plan cards */}
                <div className="grid gap-4 md:grid-cols-3">
                  {displayPlans.map((plan) => {
                    const isCurrentPlan = plan.id === currentPlanId;
                    const priceId = getPriceId(plan);

                    return (
                      <div
                        key={plan.id}
                        className={`relative rounded-lg border p-5 flex flex-col ${
                          plan.popular ? 'border-primary shadow-sm' : ''
                        } ${isCurrentPlan ? 'bg-muted/50' : ''}`}
                      >
                        {plan.popular && (
                          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                            <Badge>{t('common.popular')}</Badge>
                          </div>
                        )}
                        <div className="mb-4">
                          <h3 className="font-semibold text-lg">{plan.name}</h3>
                          <p className="text-sm text-muted-foreground mt-1">{plan.description}</p>
                        </div>
                        <div className="mb-4">
                          <span className="text-3xl font-bold">{formatPlanPrice(plan)}</span>
                        </div>
                        <ul className="space-y-2 mb-6 flex-1">
                          {plan.features.map((feature) => (
                            <li key={feature.text} className="flex items-center gap-2 text-sm">
                              {feature.included ? (
                                <Check className="size-4 text-primary shrink-0" />
                              ) : (
                                <X className="size-4 text-muted-foreground/50 shrink-0" />
                              )}
                              <span className={feature.included ? '' : 'text-muted-foreground/50'}>
                                {feature.text}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {isCurrentPlan ? (
                          <Button variant="outline" disabled className="w-full">
                            {t('billing.currentPlanButton')}
                          </Button>
                        ) : hasActiveSubscription ? (
                          <Button
                            variant={plan.popular ? 'default' : 'outline'}
                            className="w-full"
                            onClick={() => portalMutation.mutate()}
                            disabled={portalMutation.isPending}
                          >
                            {portalMutation.isPending && (
                              <Loader2 className="mr-2 size-4 animate-spin" />
                            )}
                            {t('billing.switchPlan')}
                          </Button>
                        ) : plan.id === 'free' ? (
                          <Button variant="outline" disabled className="w-full">
                            {t('billing.currentPlanButton')}
                          </Button>
                        ) : (
                          <Button
                            variant={plan.popular ? 'default' : 'outline'}
                            className="w-full"
                            onClick={() => priceId && checkoutMutation.mutate(priceId)}
                            disabled={
                              checkoutMutation.isPending || !billingStatus?.configured || !priceId
                            }
                          >
                            {checkoutMutation.isPending && (
                              <Loader2 className="mr-2 size-4 animate-spin" />
                            )}
                            {t('billing.upgrade')}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {checkoutMutation.error && (
                  <p className="text-sm text-destructive text-center">
                    {checkoutMutation.error.message}
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Payment method */}
        <Card>
          <CardHeader>
            <CardTitle>{t('billing.paymentMethod')}</CardTitle>
            <CardDescription>{t('billing.paymentMethodDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            {hasActiveSubscription ? (
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                    <CreditCard className="size-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="font-medium">{t('billing.paymentOnFile')}</p>
                    <p className="text-sm text-muted-foreground">{t('billing.manageInPortal')}</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={() => portalMutation.mutate()}
                  disabled={portalMutation.isPending}
                >
                  {portalMutation.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <ExternalLink className="mr-2 size-4" />
                  )}
                  {t('common.update')}
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between rounded-lg border border-dashed p-6">
                <div className="flex items-center gap-3">
                  <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                    <CreditCard className="size-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="font-medium">{t('billing.noPaymentMethod')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('billing.addCardDescription')}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={() => setupMutation.mutate()}
                  disabled={setupMutation.isPending || !billingStatus?.configured}
                >
                  {setupMutation.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <CreditCard className="mr-2 size-4" />
                  )}
                  {t('billing.addCard')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Billing history */}
        <Card>
          <CardHeader>
            <CardTitle>{t('billing.billingHistory')}</CardTitle>
            <CardDescription>{t('billing.billingHistoryDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            {hasActiveSubscription ? (
              <div className="flex flex-col items-center justify-center py-6 text-center">
                <p className="text-muted-foreground mb-4">{t('billing.viewInPortal')}</p>
                <Button
                  variant="outline"
                  onClick={() => portalMutation.mutate()}
                  disabled={portalMutation.isPending}
                >
                  {portalMutation.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <ExternalLink className="mr-2 size-4" />
                  )}
                  {t('billing.viewInvoices')}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <p className="text-muted-foreground">{t('billing.noBillingHistory')}</p>
                <p className="text-sm text-muted-foreground">{t('billing.invoicesAppearHere')}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </ContentPanel>
    </>
  );
}
