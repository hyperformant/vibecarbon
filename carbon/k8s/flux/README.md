# Flux CD GitOps Configuration

This directory contains Flux CD cluster-level glue (the `clusters/` GitRepositories + Kustomizations that wire the app manifests).

You do **not** need the `flux` CLI locally — the deploy workflow installs Flux with a single `kubectl apply -f <release url>`.

## Directory layout

```
carbon/k8s/
├── flux/
│   ├── clusters/
│   │   ├── primary/vibecarbon.yaml   # GitRepository + Kustomizations (app manifests)
│   │   └── standby/vibecarbon.yaml
│   └── README.md                     # you are here
```

## How deploy wires Flux

1. The `bootstrap-flux` job in `.github/workflows/deploy.yml` applies the Flux release manifest when Flux is not already installed, then waits for the four flux-system controllers (`source`, `helm`, `kustomize`, `notification`).
2. **Database**: the Postgres StatefulSet is part of `k8s/base` (`k8s/base/db/`), but it carries per-cluster deploy-time placeholders, so the `vibecarbon-base` Kustomization drops it from its build (`$patch: delete`) and only health-checks the live `statefulset/db` the CLI's deploy created. That Kustomization uses an explicit `healthChecks` list and no `wait: true`, because Flux ignores `healthChecks` whenever `wait` is on, and `wait` only covers objects Flux applied itself. The db's Services and NetworkPolicy are reconciled by Flux like the rest of base. No chart, no HelmRelease.

   **GitOps never updates the database.** A push changes everything in base except the db StatefulSet. After an upgrade that touches the database (a db image bump, a changed `k8s/base/backup/configmap-walg.yaml`, any edit to `k8s/base/db/statefulset.yaml`), run `vibecarbon deploy <env>` from the CLI so the StatefulSet is re-rendered and rolled.

   **Clusters set up before the db StatefulSet** still carry the old database chart's Kustomization in flux-system, and `vibecarbon deploy` refuses to run beside it and prints its exact name. Do not simply delete that Kustomization: it has `prune: true`, so deleting it garbage-collects its HelmRelease, which uninstalls the old chart and deletes its database volume. Set `prune: false` on it first, then delete it, then follow the rest of the steps `vibecarbon deploy` prints (destroy and redeploy, or uninstall the old Helm release and run `vibecarbon deploy <env> -restore latest`).

   **CLI-owned objects in base** (the db StatefulSet and the registry Deployment) are stripped from Flux's build with `$patch: delete` and carry `kustomize.toolkit.fluxcd.io/prune: disabled`, so Flux never garbage-collects the live ones the CLI deploy applies.

   **The backup CronJob is deploy-owned too.** Its schedule and retention are per environment, but `k8s/base` is shared by every environment Flux reconciles from the branch, so `vibecarbon-base` drops the CronJob (`$patch: delete`, and the live object carries `prune: disabled`) and keeps no retention setting in the base ConfigMap. The CLI deploy and `.github/workflows/deploy.yml` both render the CronJob and the per-cluster `vibecarbon-backup-settings` ConfigMap with `scripts/render-backup-settings.mjs`; the workflow reads the GitHub Environment vars `BACKUP_SCHEDULE` and `BACKUP_RETENTION_DAYS` that `vibecarbon configure cicd <env>` seeds from the environment's backup config. To change them, edit `backup.schedule` (a cron expression) and `backup.retentionDays` under the environment in `.vibecarbon.json`, then run both of these so the CLI deploy and the workflow agree:

   ```bash
   vibecarbon deploy <env>
   vibecarbon configure cicd <env>
   ```

Transient source-controller fetch failures self-heal on Flux's next interval. There is no client-side reconcile poking.

## Useful commands (post-deploy, for debugging)

```bash
kubectl get gitrepository,kustomization -A
kubectl describe kustomization vibecarbon-base -n flux-system
kubectl annotate --overwrite kustomization/vibecarbon-base -n flux-system reconcile.fluxcd.io/requestedAt="$(date -u +%FT%TZ)"
kubectl logs -n flux-system deploy/kustomize-controller --tail=200
kubectl logs -n flux-system deploy/source-controller --tail=200
```

## Secrets

The app reads its own keys from the `vibecarbon-app-secrets` Secret, and the db StatefulSet and add-ons read infra passwords by key from `vibecarbon-infra-secrets`, both in the `vibecarbon` namespace (created by deploy before base is applied).

If you need to ship additional secrets through Git (e.g. for other workloads), use Sealed Secrets, SOPS, or External Secrets Operator. Phase 4 of the GitOps refactor (GitRepository-driven reconciliation, see plan doc) is when we introduce this.
