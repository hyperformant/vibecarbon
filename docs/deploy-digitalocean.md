# Vibecarbon: DigitalOcean Deployment

Deploying to DigitalOcean is fully automated by the CLI. You do not create Droplets, configure Cloud Firewalls, edit compose files, or set up replication by hand — one command provisions the infrastructure, deploys the app, and wires DNS + TLS:

```bash
vibecarbon deploy -mode compose  # or -mode compose-ha / k8s
```

This guide covers setup prerequisites, cloud resource handling, and operational procedures for DigitalOcean deployments.

---

## Why DigitalOcean?

| Feature | Benefit |
|---------|---------|
| **Developer Experience** | High-performance Droplets, simple UI, straightforward API |
| **Global Regions** | NYC1, NYC3, SFO3, AMS3, FRA1, LON1, SGP1, SYD1 |
| **Spaces Object Storage** | S3-compatible Object Storage for backups and Pulumi state |
| **DO Block Storage & CSI** | Dynamic volume provisioning for Kubernetes stateful workloads |
| **Cloud Firewalls** | Scoped network ingress/egress filtering |

---

## Prerequisites

1. **A DigitalOcean account** — [sign up](https://cloud.digitalocean.com/registrations/new)
2. **A DigitalOcean Personal Access Token** — Control Panel → API → Tokens/Keys (Read & Write). Stored as `DIGITALOCEAN_TOKEN` or `DO_TOKEN`.
3. **Spaces Access Key & Secret Key** — Control Panel → API → Spaces Access Keys. Used for the dedicated Pulumi state bucket and `wal-g` S3 database backups.
4. **A domain** you control, for the application URL and Let's Encrypt TLS certificates.
5. **Docker running locally** — images are built on your machine and pushed over SSH (`local` build mode).
6. **A Fullerene license for advanced modes** — single-server Docker Compose deploys are free on Graphite; `compose-ha` and `k8s` require a Fullerene license.

---

## Deployment Modes

| Mode | What it provisions on DigitalOcean |
|------|------------------------------------|
| `compose` | Single Droplet running the full stack under Docker Compose |
| `compose-ha` | Primary + standby Droplets in two regions, encrypted WireGuard replication mesh, Postgres streaming replication, manual one-command failover (`vibecarbon failover` repoints DNS) |
| `k8s` | k3s cluster (master Droplet + worker Droplets + dedicated Supabase Droplet) with DO CSI volumes |

> `k8s-ha` (pilot-light standby cluster) is fully supported: the standby is the same k8s stack provisioned in a second region (`-standby-region`), with failover as a DNS flip between the two clusters' own reserved IPs.

Server sizes can be selected interactively during deploy or pre-configured in `.vibecarbon.json`:
- Standard Droplets: `s-2vcpu-4gb` (minimum for compose/k3s nodes — the 4 GB floor is enforced by the size picker)
- Larger workloads: `s-4vcpu-8gb` for PostgreSQL / Supabase nodes

---

## Architecture & Storage Notes

### S3 & NetworkPolicy Egress (DO Spaces)
On DigitalOcean, same-region Spaces endpoints resolve internally to a VPC gateway IP address (e.g. `nyc3.digitaloceanspaces.com` → `10.10.15.254`). Vibecarbon's `DigitalOceanProvider` automatically injects the DO VPC CIDR into the cluster's Kubernetes NetworkPolicies (`s3-egress-vpc.yaml`), allowing continuous WAL-G backups to reach Spaces without breaching network isolation.

### StorageClass
For Kubernetes stateful workloads (`k8s`), PVCs target DigitalOcean's Block Storage CSI driver using the StorageClass `do-block-storage`.

---

## Deploying

```bash
# Interactive mode picker — select DigitalOcean as provider
vibecarbon deploy

# Scripted deployment
vibecarbon deploy prod -mode compose -region nyc3 -y
```

A deployment executes the following steps:
1. Provisions Droplets, Cloud Firewalls, and Private Networks via Pulumi
2. Configures S3 state buckets and continuous WAL-G backup buckets in Spaces
3. Creates DNS records and issues Let's Encrypt TLS certificates
4. Sideloads container images over SSH
5. Starts application services, applies database migrations, seeds admin user, and runs health probes

---

## Operations & Troubleshooting

| Task | Command |
|------|---------|
| Check health & replication | `vibecarbon status <env>` |
| Scale worker nodes | `vibecarbon scale <env>` |
| Database backup / restore | `vibecarbon backup <env>` / `vibecarbon restore <env>` |
| Failover HA standby (compose-ha) | `vibecarbon failover <env>` |
| Manage operator IP allowlist | `vibecarbon access` |
| Teardown resources | `vibecarbon destroy <env>` |

For security details, firewall locking, and process isolation, refer to [docs/security.md](./security.md).
