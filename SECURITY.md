# Security Policy

Vibecarbon provisions internet-facing infrastructure and a full authentication
stack, so we take security reports seriously and want to make them easy to file.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use one of these private channels:

- **GitHub private vulnerability reporting** (preferred): open the repository's
  **Security → Report a vulnerability** tab. This keeps the report private and
  threaded with the maintainers.
- **Email:** `security@vibecarbon.com`

Please include:

- The affected component: the `vibecarbon` CLI, or the generated `carbon`
  application template.
- The deploy mode (`compose`, `compose-ha`, `k8s`, `k8s-ha`) and provider
  (Hetzner, DigitalOcean) if relevant.
- The `vibecarbon` version (`vibecarbon -v`).
- Steps to reproduce, and the impact you believe it has.

## What is in scope

- The `vibecarbon` CLI (`src/`).
- The generated application template (`carbon/`) as it ships: default
  configuration, migrations, RLS policies, Docker Compose and Kubernetes
  manifests, and the cloud-init/firewall configuration the CLI applies.

## What is out of scope

- Infrastructure a user has modified after deployment, or third-party services
  (Hetzner, DigitalOcean, Stripe, Cloudflare) themselves.
- The license gate. Enforcement is contractual, not technical (see `TERMS.md`);
  bypassing it on your own machine is not a vulnerability.
- Findings that require an already-compromised operator workstation or a
  deliberately weakened, non-default configuration.

## Our commitment

- We aim to acknowledge a report within **3 business days** and to keep you
  updated on remediation.
- We will credit reporters who want it once a fix ships.
- Because deployments are self-hosted, remediation is delivered as a released
  version plus, where needed, an upgrade path (`vibecarbon upgrade`); we will
  describe the operator action required in the advisory.
