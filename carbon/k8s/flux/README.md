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
    ├── supabase/
    │   ├── kustomization.yaml        # configMapGenerator + resources list
    │   ├── helm-repository.yaml      # supabase-community HelmRepository
    │   └── helm-release.yaml         # supabase HelmRelease (reads supabase-values ConfigMap)
    └── cert-manager-webhook-hetzner/
        ├── kustomization.yaml
        ├── helm-repository.yaml      # hetzner-cloud HelmRepository
        └── helm-release.yaml
```

## How deploy wires Flux

1. `ensureFluxRunning(env)` — applies `https://github.com/fluxcd/flux2/releases/download/v2.8.5/install.yaml`, then `kubectl rollout status` on the four flux-system controllers (`source`, `helm`, `kustomize`, `notification`).
2. **Cert-manager webhook** (only when DNS provider = hetzner): `kubectl apply -k carbon/k8s/gitops/cert-manager-webhook-hetzner/` → `kubectl wait helmrelease/cert-manager-webhook-hetzner`.
3. **Supabase**: deploy renders `supabase.values.yaml` (substituting `{{DOMAIN}}` / `{{PROJECT_NAME}}`) into a tempdir containing the bundle files, then `kubectl apply -k <tempdir>` (kustomize generates the `supabase-values` ConfigMap from the rendered file). Then `kubectl wait helmrelease/supabase` (25 min budget).

Flux's 5-minute HelmRepository interval means transient source-controller fetch failures self-heal inside the HelmRelease wait budget. There is no client-side reconcile poking.

## Useful commands (post-deploy, for debugging)

```bash
kubectl get helmrelease,kustomization,helmrepository -A
kubectl describe helmrelease supabase -n flux-system
kubectl annotate --overwrite helmrelease/supabase -n flux-system reconcile.fluxcd.io/requestedAt="$(date -u +%FT%TZ)"
kubectl logs -n flux-system deploy/helm-controller --tail=200
kubectl logs -n flux-system deploy/source-controller --tail=200
```

## Secrets

The Supabase HelmRelease reads secrets from the `vibecarbon-secrets` Secret in the `vibecarbon` namespace (created by deploy before the HelmRelease is applied). The cert-manager-webhook-hetzner webhook reads the `hetzner` Secret (key `token`) in the `cert-manager` namespace — bound via the ClusterIssuers' `tokenSecretKeyRef`, not via chart values.

If you need to ship additional secrets through Git (e.g. for other HelmReleases), use Sealed Secrets, SOPS, or External Secrets Operator. Phase 4 of the GitOps refactor (GitRepository-driven reconciliation, see plan doc) is when we introduce this.
