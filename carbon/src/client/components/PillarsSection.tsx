import { motion, useReducedMotion } from 'framer-motion';
import { useTheme } from 'next-themes';
import { useTranslation } from 'react-i18next';
import agenticDarkUrl from '../assets/pillars/agentic-dark.svg';
import agenticLightUrl from '../assets/pillars/agentic-light.svg';
import agnosticDarkUrl from '../assets/pillars/agnostic-dark.svg';
import agnosticLightUrl from '../assets/pillars/agnostic-light.svg';
import groundedDarkUrl from '../assets/pillars/grounded-dark.svg';
import groundedLightUrl from '../assets/pillars/grounded-light.svg';
import sovereignDarkUrl from '../assets/pillars/sovereign-dark.svg';
import sovereignLightUrl from '../assets/pillars/sovereign-light.svg';

/**
 * The four pillars, as a ledger rather than a card grid.
 *
 * Registry order is load-bearing (Sovereign, Agnostic, Grounded, Agentic) and
 * pinned by tests/unit/docs/terminology-census.test.ts. Each row carries the
 * pillar name, its locked definition, the canonical belief line from
 * the 4s-claims-architecture spec, and the
 * pillar's mark from assets/pillars/ (light/dark pairs, per the Logo.tsx
 * asset convention — decorative, so aria-hidden; the name beside it is the
 * accessible label).
 *
 * Deliberately NOT a four-up card grid: the marks run down the center of the section
 * as a spine — name and definition to the left, belief to the right — with
 * hairline segments connecting mark to mark. The spine replaces the earlier
 * ledger's horizontal rules as the structural device: same commitments-
 * listed-plainly content, threaded on one axis instead of ruled into rows.
 * The spine is built from per-row stretch segments (not one absolute line)
 * because --background is transparent, so a continuous line can't be masked
 * behind the marks' open interiors.
 *
 * No numbering. The pillars are four independent guarantees, not a sequence,
 * and numbering them would assert an order the content does not have.
 */

const PILLAR_KEYS = ['sovereign', 'agnostic', 'grounded', 'agentic'] as const;

const PILLAR_MARKS: Record<(typeof PILLAR_KEYS)[number], { light: string; dark: string }> = {
  sovereign: { light: sovereignLightUrl, dark: sovereignDarkUrl },
  agnostic: { light: agnosticLightUrl, dark: agnosticDarkUrl },
  grounded: { light: groundedLightUrl, dark: groundedDarkUrl },
  agentic: { light: agenticLightUrl, dark: agenticDarkUrl },
};

// The marks alternate the two brand accents down the spine (teal, magenta,
// teal, magenta); each tagline takes its own mark's accent so the pair reads
// as one unit.
const PILLAR_ACCENT: Record<(typeof PILLAR_KEYS)[number], string> = {
  sovereign: 'text-primary',
  agnostic: 'text-secondary-accent',
  grounded: 'text-primary',
  agentic: 'text-secondary-accent',
};

export function PillarsSection() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const { resolvedTheme } = useTheme();
  const markTheme = resolvedTheme === 'light' ? 'light' : 'dark';

  return (
    <section id="pillars" className="relative py-24 md:py-36">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mx-auto max-w-3xl text-center">
          <div className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
            {t('landing.pillars.eyebrow')}
          </div>
          <h2 className="mt-5 text-3xl font-black tracking-tight md:text-5xl">
            {t('landing.pillars.headline')}{' '}
            <span className="text-primary">{t('landing.pillars.headlineHighlight')}</span>
          </h2>
        </div>

        <div className="mt-16 md:mt-20">
          {PILLAR_KEYS.map((key, i) => (
            <motion.div
              key={key}
              className="group py-8 md:py-0"
              initial={reduceMotion ? false : { opacity: 0, y: 16 }}
              whileInView={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.5, delay: i * 0.08, ease: 'easeOut' }}
            >
              <div className="grid gap-5 md:grid-cols-12 md:items-center md:gap-10">
                <div className="md:col-span-5 md:py-14 md:text-right">
                  <h3 className="text-4xl font-black tracking-tight text-foreground md:text-5xl lg:text-6xl">
                    {t(`landing.pillars.${key}.name`)}
                  </h3>
                </div>

                {/* Spine node: the mark on its vertical hairline. Text columns
                    carry the row padding so the segments meet flush between
                    rows and read as one continuous axis. */}
                <div className="order-first flex md:order-none md:col-span-2 md:h-full md:flex-col md:items-center md:self-stretch">
                  <div className="hidden w-px flex-1 bg-border/60 md:block" />
                  <img
                    src={PILLAR_MARKS[key][markTheme]}
                    alt=""
                    aria-hidden="true"
                    className="h-16 w-16 md:my-4 md:h-24 md:w-24"
                  />
                  <div className="hidden w-px flex-1 bg-border/60 md:block" />
                </div>

                {/* The definition heads the description it defines — the name
                    stands alone on its side of the spine. */}
                <div className="max-w-xl md:col-span-5 md:py-14">
                  <div
                    className={`font-mono text-xs uppercase tracking-[0.18em] ${PILLAR_ACCENT[key]}`}
                  >
                    {t(`landing.pillars.${key}.definition`)}
                  </div>
                  <p className="mt-3 text-base leading-relaxed text-muted-foreground md:text-lg">
                    {t(`landing.pillars.${key}.belief`)}
                  </p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
