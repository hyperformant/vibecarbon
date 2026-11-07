/**
 * Vibecarbon marketing homepage.
 *
 * Route: /
 */

import { useTranslation } from 'react-i18next';
import { CTAFooter } from '../components/CTAFooter';
import { FilmGrainOverlay } from '../components/effects/FilmGrainOverlay';
import { FAQSection } from '../components/FAQSection';
import { GrowthSection } from '../components/GrowthSection';
import Hero from '../components/Hero';
import { LogoStrip } from '../components/LogoStrip';
import { NewsletterSignup } from '../components/NewsletterSignup';
import { PillarsSection } from '../components/PillarsSection';
import { SEO } from '../components/SEO';
import { StackSection } from '../components/StackSection';
import { ScrollSection } from '../components/scroll/ScrollSection';
import { ScrollytellingProvider } from '../components/scroll/ScrollytellingProvider';
import VendorMatrix from '../components/sections/vendor-matrix';
import { VibecarbonFooter } from '../components/VibecarbonFooter';
import { WorkflowSection } from '../components/WorkflowSection';

function VibecarbonCTAFooter() {
  const { t } = useTranslation();
  return (
    <>
      <CTAFooter gradient="bg-black">
        <h2 className="mb-4 text-3xl font-black tracking-tight text-white md:text-4xl">
          {t('landing.cta.headline')}
        </h2>

        <p className="mb-8 text-lg text-white/80">{t('landing.cta.subheading')}</p>

        <NewsletterSignup className="justify-center max-w-md mx-auto" />
      </CTAFooter>
      <VibecarbonFooter />
    </>
  );
}

export default function VibecarbonHome() {
  return (
    <ScrollytellingProvider>
      <div className="relative min-h-screen">
        <SEO description="Full-stack apps in minutes on the VPS provider of your choice. Auth, billing, and AI-guardrails built-in, with automated backup, restore, scale, replication, and failover." />
        <FilmGrainOverlay opacity={0.025} />

        <ScrollSection id="hero" disableEffects>
          <Hero />
        </ScrollSection>

        <div>
          <ScrollSection id="pillars">
            <PillarsSection />
          </ScrollSection>

          <ScrollSection id="workflow">
            <WorkflowSection />
          </ScrollSection>

          <ScrollSection id="stack">
            <StackSection />
          </ScrollSection>

          <ScrollSection id="performance">
            <VendorMatrix />
          </ScrollSection>

          <LogoStrip />

          <ScrollSection id="grow">
            <GrowthSection />
          </ScrollSection>

          <ScrollSection id="faq">
            <FAQSection />
          </ScrollSection>

          <VibecarbonCTAFooter />
        </div>
      </div>
    </ScrollytellingProvider>
  );
}
