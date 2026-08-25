/**
 * Vibecarbon marketing homepage.
 *
 * Route: /
 */

import { IconExternalLink as ExternalLink } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import hyperformantLogo from '../assets/hyperformant-dark.svg';
import { CTAFooter } from '../components/CTAFooter';
import { FilmGrainOverlay } from '../components/effects/FilmGrainOverlay';
import { FAQSection } from '../components/FAQSection';
import Hero from '../components/Hero';
import { LogoStrip } from '../components/LogoStrip';
import { NewsletterSignup } from '../components/NewsletterSignup';
import { PillarsSection } from '../components/PillarsSection';
import { PricingSection } from '../components/PricingSection';
import { SEO } from '../components/SEO';
import { StackSection } from '../components/StackSection';
import { ScrollSection } from '../components/scroll/ScrollSection';
import { ScrollytellingProvider } from '../components/scroll/ScrollytellingProvider';
import VendorMatrix from '../components/sections/vendor-matrix';
import { WorkflowSection } from '../components/WorkflowSection';
import { useDocsVisibility } from '../hooks/api';

function VibecarbonCTAFooter() {
  const { t } = useTranslation();
  const { userDocsEnabled, apiDocsEnabled } = useDocsVisibility();
  return (
    <CTAFooter
      gradient="bg-black"
      footerLinks={
        <>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <a
              href="https://github.com/hyperformant/vibecarbon/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-white/60 transition-colors hover:text-white flex items-center gap-1"
            >
              GitHub
              <ExternalLink className="size-3" />
            </a>
            {userDocsEnabled && (
              <Link to="/docs" className="text-sm text-white/60 transition-colors hover:text-white">
                {t('landing.footer.userDocs')}
              </Link>
            )}
            {apiDocsEnabled && (
              <Link
                to="/api/docs"
                className="text-sm text-white/60 transition-colors hover:text-white"
              >
                {t('landing.footer.apiDocs')}
              </Link>
            )}
            <Link to="/blog" className="text-sm text-white/60 transition-colors hover:text-white">
              {t('landing.footer.blog')}
            </Link>
            <Link
              to="/changelog"
              className="text-sm text-white/60 transition-colors hover:text-white"
            >
              {t('landing.footer.changelog')}
            </Link>
            <Link
              to="/contact"
              className="text-sm text-white/60 transition-colors hover:text-white"
            >
              {t('landing.footer.contact')}
            </Link>
            <Link
              to="/privacy"
              className="text-sm text-white/60 transition-colors hover:text-white"
            >
              {t('landing.footer.privacy')}
            </Link>
            <Link to="/terms" className="text-sm text-white/60 transition-colors hover:text-white">
              {t('landing.footer.terms')}
            </Link>
          </div>
          <a
            href="https://hyperformant.co/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-white/60 hover:text-white transition-colors"
          >
            <img src={hyperformantLogo} alt="Hyperformant" className="h-6" />
          </a>
        </>
      }
    >
      <h2 className="mb-4 text-3xl font-black tracking-tight text-white md:text-4xl">
        {t('landing.cta.headline')}
      </h2>

      <p className="mb-8 text-lg text-white/80">{t('landing.cta.subheading')}</p>

      <NewsletterSignup className="justify-center max-w-md mx-auto" />
    </CTAFooter>
  );
}

export default function VibecarbonHome() {
  return (
    <ScrollytellingProvider>
      <div className="relative min-h-screen">
        <SEO description="Vibecarbon launches full-stack web apps in minutes — auth, billing, security, AI-guardrails, and powerful automations built-in." />
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

          <ScrollSection id="pricing">
            <PricingSection />
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
