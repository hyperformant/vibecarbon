import type { TablerIcon as IconComponent } from '@tabler/icons-react';
import {
  IconBucket,
  IconCertificate,
  IconComponents,
  IconDeviceSdCard,
  IconFunction,
  IconKey,
  IconMail,
  IconMarkdown,
  IconPlugConnected,
  IconRouter,
  IconShieldLock,
} from '@tabler/icons-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import logoIcon from '../assets/logo-icon.svg';
import cloudflareLogo from '../assets/logos/provider-cloudflare.svg';
import digitaloceanLogo from '../assets/logos/provider-digitalocean.svg';
import hetznerLogo from '../assets/logos/provider-hetzner.svg';
import linodeLogo from '../assets/logos/provider-linode.svg';
import scalewayLogo from '../assets/logos/provider-scaleway.svg';
import vultrLogo from '../assets/logos/provider-vultr.svg';
import dockerLogo from '../assets/logos/tech-docker.svg';
import fluxLogo from '../assets/logos/tech-flux.svg';
import framerLogo from '../assets/logos/tech-framer.svg';
import grafanaLogo from '../assets/logos/tech-grafana.svg';
import honoLogo from '../assets/logos/tech-hono.svg';
import i18nextLogo from '../assets/logos/tech-i18next.svg';
import kubernetesLogo from '../assets/logos/tech-kubernetes.svg';
import postgresqlLogo from '../assets/logos/tech-postgresql.svg';
import prometheusLogo from '../assets/logos/tech-prometheus.svg';
import pulumiLogo from '../assets/logos/tech-pulumi.svg';
import reactLogo from '../assets/logos/tech-react.svg';
import reactHookFormLogo from '../assets/logos/tech-reacthookform.svg';
import reactQueryLogo from '../assets/logos/tech-reactquery.svg';
import reactRouterLogo from '../assets/logos/tech-reactrouter.svg';
import redisLogo from '../assets/logos/tech-redis.svg';
import stripeLogo from '../assets/logos/tech-stripe.svg';
import supabaseLogo from '../assets/logos/tech-supabase.svg';
import swaggerLogo from '../assets/logos/tech-swagger.svg';
import tailwindLogo from '../assets/logos/tech-tailwindcss.svg';
import traefikLogo from '../assets/logos/tech-traefikproxy.svg';
import typescriptLogo from '../assets/logos/tech-typescript.svg';
import viteLogo from '../assets/logos/tech-vite.svg';
import zodLogo from '../assets/logos/tech-zod.svg';

/**
 * The stack drawn as a cross-section: six labeled strata whose left-edge
 * accent steps teal→magenta with depth — the "nothing hidden, all the way
 * down" motif shared with the Grounded pillar mark. Each layer card carries
 * its technologies as brand-mark chips.
 *
 * Tech names are product nouns and stay untranslated; layer labels come from
 * landing.stack in the locale file. Brand marks are vendored simple-icons
 * SVGs with the brand fill stamped in (see the provider-*.svg convention).
 * Features without a real brand mark keep Tabler icons.
 */

type LayerKey = 'app' | 'api' | 'integrations' | 'edge' | 'ops' | 'infra';

/** Teal→magenta interpolation by stratum depth (0 = surface, 1 = bedrock). */
function depthColor(i: number, count: number) {
  const pct = Math.round(100 - (i / (count - 1)) * 100);
  return `color-mix(in oklch, var(--primary) ${pct}%, var(--secondary-accent))`;
}

/** A chip is either an icon-fronted feature name or a brand-marked product
 *  (one or two SVG urls); `badge` renders a muted mono affix (e.g. "add-on").
 *  Brand marks ship at their official colors, unmodified — a mark whose
 *  official color doesn't survive both themes gets a Tabler feature icon
 *  instead, never a recolored logo. */
type Chip = ({ name: string; icon: IconComponent } | { name: string; imgs: string[] }) & {
  badge?: string;
};

const LAYERS: Array<{ key: LayerKey; tech: Chip[] }> = [
  {
    key: 'app',
    tech: [
      { name: 'React 19', imgs: [reactLogo] },
      { name: 'TypeScript', imgs: [typescriptLogo] },
      { name: 'React Router 8', imgs: [reactRouterLogo] },
      { name: 'Tailwind CSS', imgs: [tailwindLogo] },
      { name: 'Shadcn UI', icon: IconComponents },
      { name: 'TanStack Query', imgs: [reactQueryLogo] },
      { name: 'Zod + React Hook Form', imgs: [zodLogo, reactHookFormLogo] },
      { name: 'Framer Motion', imgs: [framerLogo] },
      { name: 'MDX', icon: IconMarkdown },
      { name: 'i18next', imgs: [i18nextLogo] },
      { name: 'Vite 8', imgs: [viteLogo] },
    ],
  },
  {
    key: 'api',
    tech: [
      { name: 'Hono', imgs: [honoLogo] },
      { name: 'Supabase', imgs: [supabaseLogo] },
      { name: 'PostgreSQL', imgs: [postgresqlLogo] },
      { name: 'Supavisor', icon: IconPlugConnected },
      { name: 'Edge Functions', icon: IconFunction },
      { name: 'OpenAPI + Swagger docs', imgs: [swaggerLogo] },
      { name: 'Redis', imgs: [redisLogo] },
    ],
  },
  {
    key: 'integrations',
    tech: [
      { name: 'Stripe billing', imgs: [stripeLogo] },
      { name: 'OAuth sign-in', icon: IconKey },
      { name: 'SMTP email', icon: IconMail },
      { name: 'S3 object storage', icon: IconBucket },
    ],
  },
  {
    key: 'edge',
    tech: [
      { name: 'Traefik', imgs: [traefikLogo] },
      { name: 'Kong gateway', icon: IconRouter },
      { name: "Let's Encrypt TLS", icon: IconCertificate },
      { name: 'Cloudflare DNS', imgs: [cloudflareLogo] },
      { name: 'WireGuard', icon: IconShieldLock },
    ],
  },
  {
    key: 'ops',
    tech: [
      { name: 'Docker', imgs: [dockerLogo] },
      { name: 'Kubernetes', imgs: [kubernetesLogo] },
      { name: 'Pulumi', imgs: [pulumiLogo] },
      { name: 'Flux GitOps', imgs: [fluxLogo] },
      { name: 'WAL-G backups', icon: IconDeviceSdCard },
      { name: 'Grafana & Prometheus', imgs: [grafanaLogo, prometheusLogo] },
    ],
  },
  {
    key: 'infra',
    tech: [
      { name: 'Hetzner', imgs: [hetznerLogo] },
      { name: 'DigitalOcean', imgs: [digitaloceanLogo] },
      { name: 'Linode', imgs: [linodeLogo] },
      { name: 'Vultr', imgs: [vultrLogo] },
      { name: 'Scaleway', imgs: [scalewayLogo] },
    ],
  },
];

export function StackSection() {
  const { t } = useTranslation();

  return (
    <section className="relative py-24 md:py-36">
      <div className="mx-auto max-w-6xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.5 }}
          className="mb-12 text-center"
        >
          <motion.div
            className="mb-6 flex justify-center"
            animate={{ y: [0, -6, 0] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          >
            <img
              src={logoIcon}
              alt=""
              width={56}
              height={56}
              className="drop-shadow-[0_0_12px_oklch(0.82_0.14_192/0.6)]"
            />
          </motion.div>
          <h2 className="mb-4 text-3xl font-black tracking-tight md:text-5xl">
            {t('landing.stack.headline')}{' '}
            <span className="text-primary">{t('landing.stack.headlineHighlight')}</span>
          </h2>
          <p className="text-muted-foreground mx-auto max-w-2xl text-lg">
            {t('landing.stack.subheading')}
          </p>
        </motion.div>

        {/* The cross-section: each stratum's left edge and label step
            teal→magenta with depth. */}
        <div className="mx-auto max-w-4xl">
          <div className="flex flex-col gap-3">
            {LAYERS.map((layer, i) => (
              <motion.div
                key={layer.key}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.4, delay: i * 0.08 }}
              >
                <div
                  className="rounded-xl border border-border/60 border-l-2 bg-muted/40 p-4 dark:border-white/[0.06] dark:bg-white/[0.02]"
                  style={{ borderLeftColor: depthColor(i, LAYERS.length) }}
                >
                  <div
                    className="font-mono text-xs font-semibold tracking-[0.15em] uppercase"
                    style={{ color: depthColor(i, LAYERS.length) }}
                  >
                    {t(`landing.stack.layers.${layer.key}`)}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {layer.tech.map((item) => (
                      <span
                        key={item.name}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-sm font-medium dark:border-white/10"
                      >
                        {'imgs' in item ? (
                          item.imgs.map((img) => (
                            <img
                              key={img}
                              src={img}
                              alt=""
                              aria-hidden="true"
                              className="size-4 shrink-0"
                            />
                          ))
                        ) : (
                          <item.icon className="text-primary size-4 shrink-0" stroke={1.5} />
                        )}
                        {item.name}
                        {item.badge && (
                          <span className="text-muted-foreground/70 font-mono text-[10px] tracking-wider uppercase">
                            {item.badge}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
