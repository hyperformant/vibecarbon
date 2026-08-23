/**
 * License purchase completion page.
 *
 * Route: /checkout?tier=fullerene&success=true — the return URL the payment
 * provider redirects to after a completed purchase. Purchases start directly
 * from the pricing card (PricingSection posts to /license-checkout and hands
 * off to the provider's hosted checkout), so anything landing here without
 * success=true is bounced back to pricing.
 */

import { IconCheck as Check } from '@tabler/icons-react';
import { motion } from 'framer-motion';
import { Link, Navigate, useSearchParams } from 'react-router';
import { SEO } from '@/components/SEO';
import { Button } from '@/components/ui/button';

const TIER_NAMES: Record<string, string> = {
  fullerene: 'Fullerene',
};

export default function Checkout() {
  const [searchParams] = useSearchParams();
  const tierName = TIER_NAMES[searchParams.get('tier') ?? ''] ?? TIER_NAMES.fullerene;

  if (searchParams.get('success') !== 'true') {
    return <Navigate to="/#pricing" replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <SEO title={`${tierName}: Purchase Complete`} />
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mx-auto max-w-md text-center"
      >
        <div className="mb-6 inline-flex size-16 items-center justify-center rounded-2xl bg-primary/10">
          <Check className="size-8 text-primary" />
        </div>
        <h1 className="mb-3 text-2xl font-black">Welcome to {tierName}!</h1>
        <p className="mb-8 text-muted-foreground">
          Your license key will be delivered to your email. Activate it with:
        </p>
        <pre className="mb-8 rounded-xl bg-muted/50 p-4 text-left text-sm text-muted-foreground">
          <code>vibecarbon activate {'<your-key>'}</code>
        </pre>
        <Button variant="outline" asChild>
          <Link to="/">Back to Home</Link>
        </Button>
      </motion.div>
    </div>
  );
}
