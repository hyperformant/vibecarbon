import {
  IconChartBar as BarChart3,
  IconDatabase as Database,
  type TablerIcon as IconComponent,
  IconChartLine as LineChart,
  IconNetwork as Network,
  IconHierarchy3 as Workflow,
} from '@tabler/icons-react';

export interface AdminService {
  id: string;
  name: string;
  description: string;
  subtitle: string;
  icon: IconComponent;
  subdomain: string;
  /**
   * Path-based URL for production k8s routing (e.g., '/admin/studio').
   * null = service is internal only (no external URL, requires kubectl port-forward).
   * undefined = fall back to subdomain routing.
   */
  adminPath?: string | null;
  /** Environment flag to check if service is enabled (e.g., 'VITE_N8N_ENABLED') */
  envFlag?: string;
  /** If true, service is always shown (core infrastructure) */
  alwaysEnabled?: boolean;
}

const adminServices: AdminService[] = [
  {
    id: 'database',
    name: 'Supabase',
    description: 'Supabase Studio',
    subtitle: 'Manage tables, run queries, view data',
    icon: Database,
    subdomain: 'studio',
    // K8s: /admin/studio is strip-prefixed to /, then Studio redirects to /project/default.
    // Compose: subdomain routing (studio.domain) serves Studio at root directly.
    adminPath: '/admin/studio',
    alwaysEnabled: true,
  },
  {
    id: 'gateway',
    name: 'Traefik',
    description: 'Traefik Dashboard',
    subtitle: 'View routes, monitor traffic',
    icon: Network,
    subdomain: 'traefik',
    // Dashboard UI at /admin/traefik/dashboard/ (strip-prefix → api@internal /dashboard/)
    // API calls (/api/version, /api/overview, etc.) routed to api@internal at priority 12.
    adminPath: '/admin/traefik/dashboard/',
    alwaysEnabled: true,
  },
  {
    id: 'monitoring',
    name: 'Grafana',
    description: 'Grafana',
    subtitle: 'Metrics, logs, dashboards',
    icon: BarChart3,
    subdomain: 'grafana',
    adminPath: '/admin/grafana',
    envFlag: 'VITE_OBSERVABILITY_ENABLED',
  },
  {
    id: 'automation',
    name: 'n8n',
    description: 'Workflow Automation',
    subtitle: 'Visual workflows, integrations',
    icon: Workflow,
    subdomain: 'n8n',
    adminPath: '/admin/n8n',
    envFlag: 'VITE_N8N_ENABLED',
  },
  {
    id: 'analytics',
    name: 'Metabase',
    description: 'Business Intelligence',
    subtitle: 'Business intelligence, reports',
    icon: LineChart,
    subdomain: 'metabase',
    adminPath: '/admin/metabase',
    envFlag: 'VITE_METABASE_ENABLED',
  },
];

/**
 * Get the full URL for an admin service, or null if the service has no external URL.
 *
 * Routing mode is determined by VITE_ROUTING_MODE:
 * - 'subdomain' (default, compose): subdomain routing (e.g., studio.example.com)
 * - 'path' (k8s): path-based routing via adminPath (e.g., /project/default)
 *
 * Localhost always uses subdomain routing regardless of VITE_ROUTING_MODE.
 */
export function getServiceUrl(service: AdminService): string | null {
  const { protocol, hostname } = window.location;
  const routingMode = import.meta.env.VITE_ROUTING_MODE || 'subdomain';

  if (hostname.includes('localhost')) {
    // Dev: subdomain routing via docker-compose (e.g., studio.localhost).
    // Port-shifted stacks (DEV_PORT_OFFSET, set by `vibecarbon up` when
    // another project holds the defaults) serve traefik at 80+offset — a
    // port-less link would land on whichever OTHER project owns :80.
    // VITE_DEV_PORT_OFFSET is the client-visible twin `vibecarbon up`
    // writes alongside DEV_PORT_OFFSET.
    const offset = Number(import.meta.env.VITE_DEV_PORT_OFFSET || 0);
    const traefikPort = 80 + offset;
    const portSuffix = traefikPort === 80 ? '' : `:${traefikPort}`;
    return `${protocol}//${service.subdomain}.localhost${portSuffix}`;
  }

  // K8s: use path-based routing via adminPath
  if (routingMode === 'path') {
    if (service.adminPath !== undefined) {
      if (service.adminPath === null) return null; // Internal only
      return `${window.location.origin}${service.adminPath}`;
    }
  }

  // Compose / fallback: subdomain routing. The app is served at Host(${DOMAIN})
  // and the panels at <subdomain>.${DOMAIN}, so the current hostname IS the
  // base domain — stripping a label would break apex domains (studio.com).
  return `${protocol}//${service.subdomain}.${hostname}`;
}

/**
 * Get list of enabled admin services.
 *
 * Services are enabled if:
 * 1. They have alwaysEnabled: true (core infrastructure like Supabase, Traefik)
 * 2. Their VITE_*_ENABLED env var is set to 'true'
 * 3. In development mode, they can also be enabled via the services status API
 *
 * For development, set these in .env.local:
 *   VITE_N8N_ENABLED=true
 *   VITE_METABASE_ENABLED=true
 *   VITE_OBSERVABILITY_ENABLED=true
 */
export function getEnabledServices(): AdminService[] {
  return adminServices.filter((service) => {
    // Core services are always shown
    if (service.alwaysEnabled) return true;
    // Optional services need their env flag set
    if (!service.envFlag) return true;
    return import.meta.env[service.envFlag] === 'true';
  });
}

/**
 * Get all available admin services (for displaying status, etc.)
 */
export function getAllServices(): AdminService[] {
  return adminServices;
}

/**
 * Check if a specific service is enabled
 */
export function isServiceEnabled(serviceId: string): boolean {
  const service = adminServices.find((s) => s.id === serviceId);
  if (!service) return false;
  if (service.alwaysEnabled) return true;
  if (!service.envFlag) return true;
  return import.meta.env[service.envFlag] === 'true';
}

export { adminServices };
