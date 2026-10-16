# Flux CD GitOps Configuration

This directory contains Flux CD cluster-level glue (the `clusters/` GitRepositories + Kustomizations that wire the app manifests). Chart-level resources (HelmRepositories + HelmReleases) moved to `carbon/k8s/gitops/<component>/` in Phases 2–3 of the GitOps refactor (see `plans/gitops-refactor-2026-04-20.md`).

You do **not** need the `flux` CLI locally — `deploy.js` bootstraps Flux via a single `kubectl apply -f <release url>`.

## Directory layout

```
carbon/k8s/
├── flux/
│   ├── clusters/
│   │   ├── primary/vibecarbon.yaml   # GitRepository + Kustomizations (app manifests)
│   │   └── standby/vibecarbon.yaml
│   └── README.md                     # you are here
└── gitops/
    └── cert-manager-webhook-hetzner/
        ├── kustomization.yaml
        ├── helm-repository.yaml      # hetzner-cloud HelmRepository
        └── helm-release.yaml
```

## How deploy wires Flux

1. `ensureFluxRunning(env)` — applies `https://github.com/fluxcd/flux2/releases/download/v2.8.5/install.yaml`, then `kubectl rollout status` on the four flux-system controllers (`source`, `helm`, `kustomize`, `notification`).
2. **Cert-manager webhook** (only when DNS provider = hetzner): `kubectl apply -k carbon/k8s/gitops/cert-manager-webhook-hetzner/` → `kubectl wait helmrelease/cert-manager-webhook-hetzner`.
3. **Database**: the Postgres StatefulSet is part of `k8s/base` (`k8s/base/db/`), but it carries per-cluster deploy-time placeholders, so the `vibecarbon-base` Kustomization drops it from its build (`$patch: delete`) and only health-checks the live `statefulset/db` the CLI's deploy created. That Kustomization uses an explicit `healthChecks` list and no `wait: true`, because Flux ignores `healthChecks` whenever `wait` is on, and `wait` only covers objects Flux applied itself. The db's Services and NetworkPolicy are reconciled by Flux like the rest of base. No chart, no HelmRelease.

   **GitOps never updates the database.** A push changes everything in base except the db StatefulSet. After an upgrade that touches the database (a db image bump, a changed `k8s/base/backup/configmap-walg.yaml`, any edit to `k8s/base/db/statefulset.yaml`), run `vibecarbon deploy <env>` from the CLI so the StatefulSet is re-rendered and rolled.

   **Clusters set up before the db StatefulSet** still carry the `vibecarbon-supabase` Kustomization in flux-system. Do not simply delete it: it has `prune: true`, so deleting it garbage-collects its HelmRelease, which uninstalls the old chart and deletes its database volume. Set `prune: false` on it first, then delete it, then follow the steps `vibecarbon deploy` prints for a chart-era cluster (destroy and redeploy, or `helm uninstall supabase -n vibecarbon` and `vibecarbon deploy <env> -restore latest`).

Flux's 5-minute HelmRepository interval means transient source-controller fetch failures self-heal inside the HelmRelease wait budget. There is no client-side reconcile poking.

## Useful commands (post-deploy, for debugging)

```bash
kubectl get helmrelease,kustomization,helmrepository -A
kubectl describe kustomization vibecarbon-base -n flux-system
kubectl annotate --overwrite kustomization/vibecarbon-base -n flux-system reconcile.fluxcd.io/requestedAt="$(date -u +%FT%TZ)"
kubectl logs -n flux-system deploy/helm-controller --tail=200
kubectl logs -n flux-system deploy/source-controller --tail=200
```

## Secrets

The db StatefulSet and the app read secrets from the `vibecarbon-secrets` Secret in the `vibecarbon` namespace (created by deploy before base is applied). The cert-manager-webhook-hetzner webhook reads the `hetzner` Secret (key `token`) in the `cert-manager` namespace — bound via the ClusterIssuers' `tokenSecretKeyRef`, not via chart values.

If you need to ship additional secrets through Git (e.g. for other HelmReleases), use Sealed Secrets, SOPS, or External Secrets Operator. Phase 4 of the GitOps refactor (GitRepository-driven reconciliation, see plan doc) is when we introduce this.
