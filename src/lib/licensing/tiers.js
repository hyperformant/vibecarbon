/**
 * License tier definitions for Vibecarbon
 *
 * Graphite tier: Free — single-server Compose production deploys + local dev
 * Fullerene tier: Advanced deploy modes (Compose HA, Kubernetes, Kubernetes
 *   HA) + GitOps CI/CD, for your own products
 * Agency tier: Contact-us channel — deploy for clients and enterprise
 *   (client/white-label/reseller rights), custom terms. No self-serve
 *   checkout.
 */

export const TIERS = {
  graphite: {
    name: 'Graphite',
    displayName: 'Vibecarbon Graphite',
    features: ['local-dev', 'docker-compose', 'all-addons'],
    maxServers: 1,
    license: 'FSL-1.1-MIT',
    deployFlags: [],
    // Pricing
    price: 0,
    originalPrice: 0,
    discountPercent: 0,
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
  fullerene: {
    name: 'Fullerene',
    displayName: 'Vibecarbon Fullerene',
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
    maxServers: Infinity,
    license: 'FSL-1.1-MIT',
    deployFlags: ['--ha', '--k8s'],
    // Pricing
    price: 149,
    originalPrice: 299,
    discountPercent: 50,
    badge: 'One-Time Purchase',
    // Marketing
    marketingFeatures: [
      'Advanced deploy modes: Compose HA, Kubernetes, Kubernetes HA',
      'High availability, multi-region, and one-command failover',
      'GitOps CI/CD (`configure cicd`)',
      'Full Vibecarbon stack',
      'All add-ons (observability, n8n, metabase, redis, CI/CD)',
      'Advanced monitoring & alerting',
      'Unlimited servers & projects',
      'Email support',
      'For your own products',
    ],
  },
  agency: {
    name: 'Agency',
    displayName: 'Vibecarbon Agency',
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
      'client-deploys',
    ],
    maxServers: Infinity,
    license: 'FSL-1.1-MIT + Commercial Agreement',
    deployFlags: ['--ha', '--k8s'],
    // Pricing — contact-us channel, no self-serve checkout
    price: null,
    contact: true,
    // Marketing
    marketingFeatures: [
      'Deploy for clients and enterprise',
      'Embed, white-label, or resell Vibecarbon-powered services',
      'Custom terms',
      'All deployment modes (Compose, Compose HA, Kubernetes, Kubernetes HA)',
      'Full Vibecarbon stack',
      'Priority support',
    ],
  },
};

/**
 * Get tier by name
 * @param {string} tierName - The tier name (graphite, fullerene, agency)
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
  const order = { graphite: 0, fullerene: 1, agency: 2 };
  const a = order[tierA] ?? -1;
  const b = order[tierB] ?? -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
