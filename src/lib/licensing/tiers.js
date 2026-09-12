/**
 * License tier definitions for Vibecarbon
 *
 * Graphite tier: Free, no key — single-server Compose production deploys +
 *   local dev.
 * Graphene tier: Per-project subscription — Kubernetes deploys.
 * Fullerene tier: Per-project subscription — any HA deploy mode (Compose HA,
 *   Kubernetes HA) + GitOps CI/CD.
 *
 * The Agency tier has been retired; there is no contact-us / custom-terms
 * channel any more.
 */

export const TIERS = {
  graphite: {
    id: 'graphite',
    name: 'Graphite',
    displayName: 'Vibecarbon Graphite',
    tagline: 'Go live.',
    features: ['local-dev', 'docker-compose', 'all-addons'],
    license: 'FSL-1.1-MIT',
    deployFlags: [],
    // Pricing
    price: 0,
    billing: 'free',
    annualPrice: null,
    deployTiers: ['compose'],
    // Marketing
    marketingFeatures: [
      'Create projects',
      'Local development',
      'Single-server production deploys (Docker Compose)',
      'Backups, restore, and scaling',
      'Full Vibecarbon stack',
      'All add-ons (observability, n8n, metabase, redis, CI/CD)',
      'Fair Source, audit, fork, use commercially',
      'Community support',
    ],
  },
  graphene: {
    id: 'graphene',
    name: 'Graphene',
    displayName: 'Vibecarbon Graphene',
    tagline: 'Scale on demand.',
    features: ['docker-compose', 'kubernetes', 'autoscaling', 'advanced-monitoring', 'all-addons'],
    license: 'FSL-1.1-MIT',
    deployFlags: ['--k8s'],
    // Pricing
    price: 19,
    billing: 'per-project-monthly',
    annualPrice: 190,
    deployTiers: ['k8s'],
    // Marketing
    marketingFeatures: [
      'Kubernetes deploys',
      'Autoscaling',
      'Full Vibecarbon stack',
      'All add-ons (observability, n8n, metabase, redis, CI/CD)',
      'Advanced monitoring & alerting',
      'Email support',
    ],
  },
  fullerene: {
    id: 'fullerene',
    name: 'Fullerene',
    displayName: 'Vibecarbon Fullerene',
    tagline: 'Enterprise resiliency.',
    features: [
      'docker-compose',
      'kubernetes',
      'autoscaling',
      'single-vps',
      'ha',
      'multi-region',
      'failover',
      'advanced-monitoring',
      'all-addons',
    ],
    license: 'FSL-1.1-MIT',
    deployFlags: ['--ha', '--k8s'],
    // Pricing
    price: 39,
    billing: 'per-project-monthly',
    annualPrice: 390,
    deployTiers: ['k8s-ha', 'compose-ha'],
    // Marketing
    marketingFeatures: [
      'Advanced deploy modes: Compose HA, Kubernetes HA',
      'High availability, multi-region, and one-command failover',
      'GitOps CI/CD (`configure cicd`)',
      'Full Vibecarbon stack',
      'All add-ons (observability, n8n, metabase, redis, CI/CD)',
      'Advanced monitoring & alerting',
      'Email support',
      'For your own products',
    ],
  },
};

/**
 * Get tier by name
 * @param {string} tierName - The tier name (graphite, graphene, fullerene)
 * @returns {object|null} The tier configuration or null if not found
 */
export function getTier(tierName) {
  return TIERS[tierName] || null;
}

/**
 * Check if a tier has access to a specific feature
 * @param {string} tierName - The tier name
 * @param {string} feature - The feature to check
 * @returns {boolean} Whether the tier has access to the feature
 */
export function hasFeature(tierName, feature) {
  const tier = getTier(tierName);
  return tier ? tier.features.includes(feature) : false;
}

/**
 * Compare two tiers and return which one is higher
 * @param {string} tierA - First tier name
 * @param {string} tierB - Second tier name
 * @returns {number} -1 if A < B, 0 if equal, 1 if A > B
 */
export function compareTiers(tierA, tierB) {
  const order = { graphite: 0, graphene: 1, fullerene: 2 };
  const a = order[tierA] ?? -1;
  const b = order[tierB] ?? -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
