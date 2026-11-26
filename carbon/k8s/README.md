# Vibecarbon Kubernetes Deployment

> **Note**: For the full deployment flow and provider options, see the [deployment guide](../content/docs/deployment.mdx) (rendered at `/docs/deployment`).

This directory contains Kubernetes manifests for deploying Vibecarbon with enterprise-grade autoscaling and high availability.

## Architecture Overview

```
                            DNS
                (manual one-command failover)
                           |
           +---------------+---------------+
           |                               |
    Hetzner LB (nbg1)              Hetzner LB (hel1)
           |                               |
    k3s Cluster                     k3s Cluster
    +--------------+               +--------------+
    | app: 2-10    |   WAL repl    | app: 0 (standby)
    | PostgreSQL   | <-----------> | PostgreSQL (replica)
    | PRIMARY      |               | HOT STANDBY
    +--------------+               +--------------+
```

## Directory Structure

```
k8s/
├── base/                          # Base Kubernetes manifests
│   ├── namespace.yaml
│   ├── network-policy.yaml        # Default-deny NetworkPolicy
│   ├── secrets/                   # Secrets and ConfigMaps
│   ├── db/                       # PostgreSQL StatefulSet (deploy-time placeholders)
│   ├── app/                      # Vibecarbon application
│   │   ├── deployment.yaml
│   │   ├── local-registry.yaml   # Local OCI registry for k3s image distribution
│   │   └── rbac.yaml             # ServiceAccount for pod listing
│   └── traefik/                  # Ingress controller
├── infra/                         # Infrastructure-level resources (applied once)
│   └── cert-manager-resources/   # ClusterIssuers for TLS certificates
├── overlays/
│   └── production/               # Example overlay on top of base (nothing applies it)
└── flux/                          # GitOps configuration (vibecarbon configure cicd)
    └── clusters/
        ├── primary/              # One Flux Kustomization, vibecarbon-base, at ./k8s/base
        └── standby/
```

## Prerequisites

1. **Hetzner Cloud Account** with API token
2. **Cloudflare Account** with API token and domain
3. **kubectl** installed locally
4. **kustomize** installed (or use `kubectl -k`)
5. Nothing extra for GitOps: `vibecarbon configure cicd <env>` installs Flux with `kubectl`, so you don't need the `flux` CLI

## Deployment Steps

### Step 1: Provision Infrastructure

`vibecarbon deploy <env>` provisions the Hetzner servers, network, firewall,
and floating IP via Pulumi (Automation API; no Pulumi CLI required). Stack
state is stored in your Hetzner S3 bucket — there are no `.tf` files or
local state to manage.

```bash
vibecarbon deploy production
```

For HA (two regions), pass `--ha`. The command writes the resulting
kubeconfig(s) to `~/.vibecarbon/kubeconfig-<env>-<region>.yaml`.

### Step 2: Get Kubeconfig

```bash
export KUBECONFIG=~/.vibecarbon/kubeconfig-production-nbg1.yaml

# For HA, the standby kubeconfig is alongside it:
# ~/.vibecarbon/kubeconfig-production-hel1.yaml
```

### Step 3: Deploy Secrets

Before deploying, update the secrets with real values:

```bash
# Create secrets manually (recommended for initial setup)
kubectl create secret generic vibecarbon-infra-secrets \
  --namespace=vibecarbon \
  --from-literal=DB_PASSWORD=<your-password>

# The app's own keys (BETTER_AUTH_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, ...)
kubectl create secret generic vibecarbon-app-secrets \
  --namespace=vibecarbon \
  --from-literal=BETTER_AUTH_SECRET=<64 random characters>
```

Your cloud provider's API token needs no Secret from you. `vibecarbon deploy`
hands it to the cluster on every deploy (kube-system/hcloud on Hetzner) and
restarts what reads it when it changes, so a rotated token takes effect on
your next deploy.

### Step 4: Apply the Manifests

`vibecarbon deploy` (Step 1) already applied `k8s/base` to the cluster, and
for HA to the standby cluster too. It fills in the deploy-time values first
(the domain, images, storage class and more), so run it again after you change
a manifest:

```bash
vibecarbon deploy production
```

A plain `kubectl apply -k` of `base/` or `overlays/production/` would apply
those values unfilled.

### Step 5: Verify Deployment

```bash
# Check pods
kubectl get pods -n vibecarbon

# Check HPA
kubectl get hpa -n vibecarbon

# Check services
kubectl get svc -n vibecarbon

# Check ingress/load balancer
kubectl get svc traefik -n vibecarbon
```

## GitOps (optional)

Once the cluster is up, let it deploy itself from your repo:

```bash
vibecarbon configure cicd production
```

From your machine, the command installs Flux on each cluster (a k8s-ha standby
too), gives it a read-only deploy key of its own on your repo, adds the app
image's pull Secret when the image is private, applies
`flux/clusters/primary/vibecarbon.yaml`, and waits for the first sync. From
then on the cluster pulls `main` and applies `k8s/base` itself, so nothing at
GitHub ever connects to it. Flux leaves your secrets, the database, the TLS
certificate, the backup schedule and the Traefik and registry Deployments to
`vibecarbon deploy`, so run it again after you change a secret. See
[flux/README.md](flux/README.md) for the details.

## Autoscaling

### Horizontal Pod Autoscaler (HPA)

The following services have HPA configured:

| Service | Min Replicas | Max Replicas | CPU Target |
|---------|--------------|--------------|------------|
| app     | 2            | 10           | 70%        |

Worker VMs are provisioned at deploy time; the interactive deploy prompt asks for the worker bounds (default `min=1, max=3`) and persists them in the environment's config (`.vibecarbon.json`). The static floor is Pulumi-managed; cluster-autoscaler spawns and reaps additional workers (up to `max - min`) based on pending-pod pressure. See the Cluster Autoscaler section below.

### Cluster Autoscaler (VPS-level)

VPS-level autoscaling is on by default with a bounded ceiling — every k8s deploy installs cluster-autoscaler against the Hetzner Cloud API.

**Defaults**

- `min=1, max=3` — one static worker, plus up to two CA-spawned workers on demand.

**Deploy-time bounds**

```bash
# The interactive deploy prompt asks for worker bounds (persisted per env)
vibecarbon deploy prod -mode k8s
```

**Re-tuning bounds without a full deploy**

```bash
# The interactive scale flow re-tunes the CA bounds — no Pulumi run needed
# for the CA-managed pool
vibecarbon scale prod
```

**Static floor + CA-on-top model**

| Layer | Managed by | Server name pattern |
|-------|-----------|---------------------|
| Static floor (`minWorkers` nodes) | Pulumi | `<cluster>-worker-N` (deterministic) |
| CA-spawned (0 to `max - min` extra nodes) | cluster-autoscaler via Hetzner Cloud API | `worker-pool-<rand>` |

The static floor is what your project quota is reserved for; CA scales additional workers on top of it as pending pods appear, then reaps them when CPU pressure subsides.

**HA mode symmetry**

In `--ha` mode both clusters use the same `--min-workers/--max-workers` bounds — the standby is kept failover-ready (its scaler doesn't bring up additional workers while the cluster is dormant, but the bounds are pre-configured so failover is instant). While dormant, the standby's TLS certificate is intentionally self-signed (only the primary holds a Let's Encrypt certificate, because Let's Encrypt validates over HTTP-01 and only the cluster your DNS points at can answer); failover re-points the standby's certificate at the real issuer as part of promotion, so the promoted cluster serves a trusted certificate within a couple of minutes.

**Hetzner project quota**

Trial Hetzner Cloud projects cap at ~50 servers across all resource types; verified accounts get higher limits. If you set `--max-workers` aggressively, make sure your project quota covers the worst case across all clusters in the project (master + database + workers + CA-spawned, x2 in HA).

**Token requirement: Read+Write**

The Hetzner Cloud API token you deploy with (`HETZNER_API_TOKEN`) must have **Read+Write** permissions on the project. Read-only tokens cannot create servers, and CA scale-up will fail silently with permission errors in the cluster-autoscaler pod logs. Verify with:

```bash
kubectl logs -n kube-system -l app=cluster-autoscaler --tail=200 | grep -i 'permission\|forbidden\|unauthor'
```

## Failover

Cloudflare DNS health checks monitor both regions every 60 seconds. When the primary region fails, initiate failover with one command:

```bash
vibecarbon failover prod
```

This promotes the standby database to primary, scales up services in the standby region, switches the promoted cluster's TLS certificate onto the real ACME issuer, and updates DNS to point to the new primary.

### Manual Failover (kubectl)

To failover manually with kubectl:

```bash
# Scale up standby
export KUBECONFIG=kubeconfig-hel1.yaml
kubectl scale deployment app --replicas=2 -n vibecarbon
```

## Monitoring (Optional)

To enable Prometheus + Grafana monitoring:

```bash
kubectl apply -k base/monitoring/  # If monitoring manifests exist
```

## Troubleshooting

### Pods not starting

```bash
kubectl describe pod <pod-name> -n vibecarbon
kubectl logs <pod-name> -n vibecarbon
```

### Load Balancer not created

```bash
kubectl describe svc traefik -n vibecarbon
kubectl logs -l app=hcloud-cloud-controller-manager -n kube-system
```

## Cost Estimate

| Component | Monthly Cost (EUR) |
|-----------|-------------------|
| k3s master x2 | 8.70 |
| k3s workers (1-10) | 4-44 |
| Hetzner LB x2 | 10.78 |
| Hetzner volumes | ~2 |
| **Total** | **~25-65** |
