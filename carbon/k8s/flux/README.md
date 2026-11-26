# Flux CD GitOps Configuration

This directory contains Flux CD cluster-level glue (the `clusters/` GitRepositories + Kustomizations that wire the app manifests).

Once a cluster runs Flux, a push under `k8s/` to `main` deploys it: the cluster pulls your repo with its own read-only deploy key, so nothing at GitHub ever connects to it.

You do **not** need the `flux` CLI locally. `vibecarbon configure cicd <env>` installs Flux from your machine with a single `kubectl apply -f <release url>`.

## Directory layout

```
carbon/k8s/
├── flux/
│   ├── clusters/
│   │   ├── primary/vibecarbon.yaml   # GitRepository + Kustomizations (app manifests)
│   │   └── standby/vibecarbon.yaml
│   └── README.md                     # you are here
```

## How `configure cicd` wires Flux

1. `vibecarbon configure cicd <env>` runs on each cluster from your machine, since the k8s API admits only your saved addresses (one call covers a k8s-ha primary and standby, and each gets its own pass). In order, it:
   - applies the Flux v2.10.0 release manifest when Flux is not already installed, then waits for the four flux-system controllers (`source`, `helm`, `kustomize`, `notification`);
   - adds a new read-only deploy key to your repo, titled `vibecarbon flux <cluster>` (`prod`, or `prod-primary` and `prod-standby`), writes its private half with GitHub's host keys into the `flux-system/flux-system` Secret the GitRepository names, then removes every other key with that title;
   - writes `vibecarbon/ghcr-pull-secret` (a classic token with only `read:packages`) when the app image is private;
   - applies `clusters/primary/vibecarbon.yaml`, on a k8s-ha standby too (nothing applies `clusters/standby/` today);
   - asks the GitRepository and then the Kustomization for one reconcile and waits up to 10 minutes for Flux to handle it.

   From then on the GitRepository fetches `main` over ssh every minute, and the Kustomization applies `k8s/base`. A rerun walks the same steps and rotates the key.
2. **Database**: the Postgres StatefulSet is part of `k8s/base` (`k8s/base/db/`), but it carries per-cluster deploy-time placeholders, so the `vibecarbon-base` Kustomization drops it from its build (`$patch: delete`) and only health-checks the live `statefulset/db` the CLI's deploy created. That Kustomization uses an explicit `healthChecks` list and no `wait: true`, because Flux ignores `healthChecks` whenever `wait` is on, and `wait` only covers objects Flux applied itself. The db's Services and NetworkPolicy are reconciled by Flux like the rest of base. No chart, no HelmRelease.

   **GitOps never updates the database.** A push changes everything in base except the db StatefulSet. After an upgrade that touches the database (a db image bump, a changed `k8s/base/backup/configmap-walg.yaml`, any edit to `k8s/base/db/statefulset.yaml`), run `vibecarbon deploy <env>` from the CLI so the StatefulSet is re-rendered and rolled.

   **Clusters set up before the db StatefulSet** still carry the old database chart's Kustomization in flux-system, and `vibecarbon deploy` refuses to run beside it and prints its exact name. Do not simply delete that Kustomization: it has `prune: true`, so deleting it garbage-collects its HelmRelease, which uninstalls the old chart and deletes its database volume. Set `prune: false` on it first, then delete it, then follow the rest of the steps `vibecarbon deploy` prints (destroy and redeploy, or uninstall the old Helm release and run `vibecarbon deploy <env> -restore latest`).

   **CLI-owned objects in base** (the db StatefulSet, the registry and Traefik Deployments, the TLS Certificate, and every PersistentVolumeClaim) are stripped from Flux's build with `$patch: delete` and carry `kustomize.toolkit.fluxcd.io/prune: disabled`, so Flux never garbage-collects the live ones the CLI deploy applies. A claim is an add-on's volume (redis, for example): it names the provider's storage class, rendered per cluster, and a claim's class can't change once it exists, so `vibecarbon deploy <env>` creates it. After `vibecarbon add` on a GitOps project, run that deploy once before the add-on can start.

   **The backup CronJob is deploy-owned too.** Its schedule and retention are per environment, but `k8s/base` is shared by every environment Flux reconciles from the branch, so `vibecarbon-base` drops the CronJob (`$patch: delete`, and the live object carries `prune: disabled`) and keeps no retention setting in the base ConfigMap. `vibecarbon deploy <env>` renders the CronJob and the per-cluster `vibecarbon-backup-settings` ConfigMap from the environment's backup config with `scripts/render-backup-settings.mjs`, on a GitOps cluster as on any other. To change them, edit `backup.schedule` (a cron expression) and `backup.retentionDays` under the environment in `.vibecarbon.json`, then run:

   ```bash
   vibecarbon deploy <env>
   ```

Transient source-controller fetch failures self-heal on Flux's next interval. `configure cicd` asks for one reconcile only to wait for its first sync; after that nothing outside the cluster pokes Flux.

## Useful commands (post-deploy, for debugging)

```bash
kubectl get gitrepository,kustomization -A
kubectl describe kustomization vibecarbon-base -n flux-system
kubectl annotate --overwrite kustomization/vibecarbon-base -n flux-system reconcile.fluxcd.io/requestedAt="$(date -u +%FT%TZ)"
kubectl logs -n flux-system deploy/kustomize-controller --tail=200
kubectl logs -n flux-system deploy/source-controller --tail=200
```

## Secrets

The app reads its own keys from the `vibecarbon-app-secrets` Secret, and the db StatefulSet and add-ons read infra passwords by key from `vibecarbon-infra-secrets`, both in the `vibecarbon` namespace (created by deploy before base is applied). `vibecarbon deploy <env>` writes both from your `.env.local`, and Flux never builds them, so after you change a secret, run:

```bash
vibecarbon deploy <env>
```

Nothing is copied to GitHub for them. If you need to ship additional secrets through Git (e.g. for other workloads), use Sealed Secrets, SOPS, or External Secrets Operator.
