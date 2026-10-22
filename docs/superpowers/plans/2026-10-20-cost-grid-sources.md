# Cost grid: draft, sources and calculation

Evidence for `2026-10-20-price-optimized-defaults.md`. First drafted 2026-10-20; every price and availability fact below was re-read from the provider APIs on **2026-10-22** (read-only GETs, tokens never printed). The trimmed 2026-10-22 catalogs are committed as unit fixtures in `tests/unit/fixtures/catalogs/2026-10-22/`, so the tests pin the same snapshot this file quotes. Net of VAT. Hetzner bills this account in USD.

What changed between the two reads:

- Hetzner `cx23` is orderable nowhere on 2026-10-22 (`available: false` in fsn1, nbg1 and hel1). On 2026-10-20 it was orderable in hel1, which made hel1 the cheapest Hetzner location by far. The Hetzner row moves from $7.09 / $30.68 / $25.61 / $67.63 to $23.59 / $47.18 / $65.61 / $107.64. The synthetic fixture `tests/unit/fixtures/catalogs/flux-hetzner-cx23-hel1.json` keeps the 2026-10-20 shape for tests.
- Hetzner Object Storage is $7.99 per month on a USD account (€6.49 on a EUR account).
- DigitalOcean `s-2vcpu-4gb` / `s-1vcpu-2gb` are now also sold in fra1 and syd1. Still not in sfo3 or atl1. The grid is unchanged.
- Vultr, Linode and Scaleway prices are unchanged. Scaleway `BASIC3-X2C-4G` (today's default) is `scarce` in fr-par-1 and fr-par-2.

## Section 1: the README grid (draft)

### What it costs to run

You pay your cloud provider directly. This is the monthly bill for one environment, on the cheapest servers you can order today that fit the measured load.

**What each mode runs**

| Mode | Servers | Peak RAM used per server |
|---|---|---|
| compose | 1 | 1.10 GB |
| compose-ha | 2 (primary + standby in a second location) | 1.25 GB |
| k8s | 3 (master, database, worker) | 1.49 GB master, 0.64 GB database, 1.05 GB worker |
| k8s-ha | 5 (3 primary + 2 standby in a second location) | 1.56 GB master, 0.66 GB database |

**Monthly cost per environment**

| Provider | compose | compose-ha | k8s | k8s-ha |
|---|---|---|---|---|
| Hetzner (USD account) | $23.59 (nbg1) | $47.18 (nbg1 + fsn1) | $65.61 (nbg1) | $107.64 (nbg1 + fsn1) |
| DigitalOcean | $24 (nyc3) | $48 (nyc3 + tor1) | $61 (nyc3) | $98 (nyc3 + tor1) |
| Vultr | $20 (ewr) | $40 (ewr + ord) | not yet | not yet |
| Linode | $24 (us-iad) | $48 (us-iad + us-ord) | not yet | not yet |
| Scaleway | €21.84 (fr-par-1) | €43.68 (fr-par-1 + nl-ams-1) | not yet | not yet |

Plus object storage for backups and uploads, billed once per provider account and shared by every project on it: Hetzner $7.99 (€6.49 on a EUR account), DigitalOcean $5, Linode $5, Vultr $18, Scaleway usage-based (cents at this size).

<details>
<summary>At the sizes vibecarbon picks by default today</summary>

| Provider (default region) | compose | compose-ha | k8s | k8s-ha |
|---|---|---|---|---|
| Hetzner (nbg1, USD account) | $42.59 | $85.18 | $94.11 | $164.64 |
| DigitalOcean (nyc3) | $24 | $48 | $61 | $104 |
| Vultr (ewr) | $20 | $40 | not yet | not yet |
| Linode (us-iad) | $24 | $48 | not yet | not yet |
| Scaleway (fr-par-1) | €35.90 | €71.79 | not yet | not yet |

</details>

<sub>Prices and availability from each provider's API on 22 October 2026, excluding VAT. Each server has at least twice its measured peak RAM and compose servers never go below 4 GB. Totals include billed public IPv4 (Hetzner, Scaleway), the k8s ingress IP and database volume, and Scaleway's 40 GB root volume. A region in a cell is where that price is orderable today; HA standbys sit in a second location on the same continent, priced at the cheapest type stocked there. Peak RAM was measured on Hetzner with the observability add-on running, so a default install uses less. Hetzner bills this account in USD; EU accounts are billed in EUR. Hetzner's cx23 at $7.09 appears in some EU locations when stocked; new deploys pick it automatically when it is.</sub>

(Ruling B3: the grid shows what is orderable today, with that one footnote sentence for cx23. Ruling B5: the ARM saving stays out of customer copy; the calculation is kept in Section 2.)

## Section 2: sources and calculation

### Supported provider x mode (`SUPPORTED_TIERS`)

- hetzner, digitalocean: compose, compose-ha, k8s, k8s-ha (`src/lib/providers/hetzner.js`, `digitalocean.js`).
- vultr, linode, scaleway: compose, compose-ha.

### Default sizes today (what a deploy picks with no flags, before this plan)

- Compose/compose-ha server = `regionDefaults.dbType` (`src/lib/deploy/prompts.js`, compose branch), not `DEFAULT_COMPOSE_TYPE`.
- k8s = `regionDefaults` master/db/worker; `minWorkers` default 1 (`src/lib/deploy/utils.js`).
- k8s-ha: primary master + db + 1 worker; pilot-light standby master + db, `minWorkers` 0 (`src/lib/deploy/effects/k8s-ha.js`).
- Hetzner `getRegionDefaults`, live catalog for nbg1: smallShared -> cpx22 (cpx11 is ash/hil only), mediumShared -> **cpx32** (4 vCPU, 8 GB). So compose = cpx32; k8s = cpx22 / cpx32 / cpx22.
- DigitalOcean: master/worker s-2vcpu-2gb, db/compose s-2vcpu-4gb.
- Linode: g6-standard-2 (4 GB). Vultr: vc2-2c-4gb. Scaleway: BASIC3-X2C-4G with a 40 GB SBS root volume.
- Compose floor `COMPOSE_MIN_RAM_GB = 4` (`src/lib/server-types.js`).

### Billable resources per environment (IaC programs)

- hetzner-compose: 1 server (+ primary IPv4). compose-ha = 2 of these.
- hetzner-k8s: 3 servers (+3 primary IPv4), 1 floating IPv4 (ingress), network / placement group / firewall (no charge). db PVC 10Gi on hcloud-volumes (`carbon/k8s/base/db/statefulset.yaml`) = 11 GB volume.
- digitalocean-k8s: 3 droplets, 1 reserved IP (no charge while assigned), VPC / firewall (no charge), db PVC 10 GiB on do-block-storage.
- linode/vultr compose: 1 instance, IPv4 included. scaleway-compose: 1 server + flexible IPv4 + 40 GB SBS root.
- Observability add-on (opt-in, off by default) adds 25 GiB of k8s volumes per cluster (grafana 5, loki 10, prometheus 10): about +$2.07 Hetzner, +$2.50 DO.
- No load balancers, no provider backups, no snapshots by default.

### Prices verified 2026-10-22

| Provider | Item | Price | Where orderable today | Source |
|---|---|---|---|---|
| Hetzner | `cx23` (2 vCPU, 4 GB, x86) | $6.49 | **nowhere** (`available: false` in fsn1/nbg1/hel1) | `/v1/server_types`, `/v1/pricing` |
| Hetzner | `cpx12` (1 vCPU, 2 GB) | $13.49 EU, $17.99 sin | fsn1, nbg1, hel1, sin | same |
| Hetzner | `cpx22` (2 vCPU, 4 GB) | $22.99 EU, $30.99 sin | fsn1, nbg1, hel1, sin | same |
| Hetzner | `cpx32` (4 vCPU, 8 GB) | $41.99 | fsn1, nbg1, hel1, sin | same |
| Hetzner | `cpx11` (2 vCPU, 2 GB) | $20.49 ash/hil ($5.99 EU, priced but deprecated there) | ash, hil | same |
| Hetzner | `cpx21` (3 vCPU, 4 GB) | $37.49 ash/hil | ash, hil | same |
| Hetzner | `ccx13` (2 dedicated vCPU, 8 GB) | $50.49 EU, $50.99 US | all six | same |
| Hetzner | `cax11` (ARM, excluded) | $6.99 | fsn1, nbg1, hel1 | same |
| Hetzner | primary IPv4 / floating IPv4 / volume | $0.60 / $3.50 / $0.0767 per GB-month | all | `/v1/pricing` |
| Hetzner | Object Storage base | €6.49 or $7.99 per month | n/a | hetzner.com/storage/object-storage (page slider data, fetched 2026-10-22) |
| DigitalOcean | `s-1vcpu-2gb` / `s-2vcpu-2gb` / `s-2vcpu-4gb` | $12 / $18 / $24 | ams3, blr1, fra1, lon1, nyc1, nyc3, sfo2, sgp1, syd1, tor1 (**not sfo3, atl1**) | `/v2/sizes` |
| DigitalOcean | `s-1vcpu-2gb-amd`/`-intel`, `s-2vcpu-4gb-amd`/`-intel` | $14, $28 | `-amd`: ams3, blr1, lon1, nyc2, nyc3, sfo3, sgp1, syd1; `-intel`: ams3, blr1, fra1, nyc2, sfo2, sfo3, sgp1, tor1 | `/v2/sizes` |
| DigitalOcean | volumes / Spaces / reserved IP | $0.10 per GiB-month / $5 per month / no charge while assigned | n/a | DO docs and pricing pages, fetched 2026-10-22 |
| Vultr | `vc2-1c-2gb` / `vc2-2c-4gb` / `vhf-2c-4gb` | $10 / $20 / $24 | all 8 code regions | `/v2/plans` (public) |
| Vultr | Object Storage Standard | $18 per month (Legacy $6 tier has no locations) | ewr, sgp, sjc, ams, blr, del, atl | `/v2/object-storage/tiers` |
| Linode | `g6-standard-1` / `g6-standard-2` | $12 / $24 (id-cgk $14.40 / $28.80, br-gru $16.80 / $33.60) | global catalog | `/v4/linode/types` (public) |
| Linode | Object Storage / volume | $5 per month / $0.10 per GB-month | n/a | `/v4/object-storage/types`, `/v4/volumes/types` |
| Scaleway | `DEV1-M` (3 vCPU, 4 GB, x86) | €14.74 | `available` in fr-par-1, fr-par-2, nl-ams-1, nl-ams-2 | `/instance/v1/zones/*/products/servers` + `/availability` |
| Scaleway | `PLAY2-NANO` (2 vCPU, 4 GB) | €20.10 | `scarce` fr-par-1, `available` elsewhere | same |
| Scaleway | `BASIC3-X2C-4G` (2 vCPU, 4 GB, today's default) | €28.80 | `scarce` fr-par-1 and fr-par-2, `available` in nl-ams-* | same |
| Scaleway | Zonal flexible IPv4 | €0.005 per hour (€3.65 per month) | n/a | public product catalog |
| Scaleway | 40 GB SBS root | €3.45 per month at €0.000118 per GB-hour | n/a | public product catalog. **Unverified:** which SBS SKU an `sbs_volume` root bills as (Low Latency 5K is €0.00013, which would make it €3.80) |
| Scaleway | Object Storage | usage-based | n/a | **unverified 2026-10-22**, carried from 2026-10-20 |

Two capture details the table does not show: Vultr plans carry a `location_cost` surcharge for `sao` (e.g. `vc2-1c-2gb` $15 there), and Linode's `g8-dedicated-*` plans carry `price.monthly: null`.

### Peak RAM

`tests/results/e2e.db`, `metric_type = 'resource'`, lean stack only (recorded after 2026-10-17, all on 2026-10-20, Hetzner, observability on), re-queried 2026-10-22:

- compose 1,073-1,101 MB; compose-ha 1,117-1,245 MB per node;
- k8s master 1,451-1,488 / db 635-636 / worker 1,021-1,050 MB;
- k8s-ha primary master 1,431-1,559, primary db 631-659, standby master 1,320-1,363, standby db 610-653 MB.
- The k8s-ha primary worker is not collected by the harness (`tests/e2e/utils/ssh.ts` `getServerIps` reads only the ha.primary/standby master + db); the k8s worker figure stands in.
- No lean-stack data for any other provider (the DigitalOcean rows are from August, the Supabase era). Same stack, so the same floors apply.

### Smallest-fit rule

Each node at least 2x its measured peak RAM, compose never under `COMPOSE_MIN_RAM_GB = 4`, cheapest x86 plan orderable in the location. As code: `ROLE_MIN_RAM_GB = { compose: 4, master: 4, db: 2, worker: 4 }` in `src/lib/sizing.js` (master 2 x 1.56 = 3.12 -> 4; db 2 x 0.66 = 1.32 -> 2; worker 2 x 1.05 = 2.10 -> 4).

### Constraints checked in code

- HA placement: standby = `ctx.secondaryRegion || Provider.getDefaultStandbyRegion(region)` (`src/lib/deploy/effects/compose-ha.js`), a different region on the same continent; the standby type is re-resolved for its own region. The standby is priced at the cheapest type stocked in a valid second location. `HA_REGIONS` is a display default only.
- k8s: every node of one cluster is in one location (`hetzner-k8s.js` uses `config.location` for all servers). Disk: no floor; cx23 (40 GB) is the e2e's own pinned type.
- Architecture: amd64 only. `assertAmd64ServerType` rejects ARM at the prompts; providers drop ARM from the live catalog. ARM is excluded and kept out of customer copy (B5).

### Calculation (headline, 2026-10-22)

- Hetzner compose: nbg1 cpx22 22.99 + IPv4 0.60 = **23.59** (fsn1 and hel1 tie). compose-ha: standby fsn1 the same, **47.18**.
- Hetzner k8s, nbg1: master cpx22 22.99 + db cpx12 13.49 + worker cpx22 22.99 + 3 x 0.60 + floating IP 3.50 + 11 GB volume 0.84 = **65.61**.
- Hetzner k8s-ha: primary 65.61 + standby fsn1 (cpx22 22.99 + cpx12 13.49 + 2 x 0.60 + 3.50 + 0.84 = 42.02) = **107.64** from the unrounded volume (107.63 rounded per line).
- DigitalOcean: compose s-2vcpu-4gb **24**; compose-ha **48**; k8s master s-2vcpu-4gb 24 + db s-1vcpu-2gb 12 + worker 24 + 1.00 volume = **61**; k8s-ha standby 24 + 12 + 1 = 37, total **98**. Standby in tor1: sfo3, the code's HA default partner, sells none of these sizes today (only the $14 / $28 `-amd`/`-intel` variants).
- Vultr vc2-2c-4gb **20** / **40**. Linode g6-standard-2 **24** / **48**.
- Scaleway: DEV1-M 14.74 + IPv4 3.65 + 40 GB SBS 3.45 = **21.84**; compose-ha **43.68**.

### Calculation (defaults today, the details table)

- Hetzner compose: cpx32 41.99 + 0.60 = 42.59; compose-ha x2 = 85.18.
- Hetzner k8s: 22.99 + 41.99 + 22.99 + 3 x 0.60 + 3.50 + 11 x 0.0767 = 94.11. Standby (master + db): 22.99 + 41.99 + 2 x 0.60 + 3.50 + 0.84 = 70.53. k8s-ha = 164.64.
- DO k8s: 18 + 24 + 18 + 1.00 = 61. Standby 18 + 24 + 1.00 = 43. k8s-ha = 104.
- Scaleway compose: BASIC3-X2C-4G 28.80 + 3.65 + 3.45 = 35.90 per rounded line (35.89 from the unrounded 28.79777 + 3.65 + 3.4456); compose-ha 71.79 from the unrounded prices (71.80 from the rounded lines). `scripts/cost-grid.js` (Task 7) rounds once, at the end.

### 2026-10-20 headline, for the record (cx23 orderable in hel1)

- Hetzner compose hel1 cx23 6.49 + 0.60 = 7.09; compose-ha 7.09 + fsn1 cpx22 23.59 = 30.68.
- Hetzner k8s hel1, cx23 for master, db and worker: 19.47 + 3 x 0.60 + 3.50 + 0.84 = 25.61; k8s-ha 25.61 + fsn1 standby 42.02 = 67.63.
- This is the shape of `flux-hetzner-cx23-hel1.json`.

### Later: ARM (not supported, not in customer copy)

Hetzner cax11 6.99 + 0.60 = 7.59 per node, every EU location: compose 7.59, compose-ha 15.18, k8s 3 x 7.59 + 3.50 + 0.84 = 27.11, k8s-ha 27.11 + (2 x 7.59 + 3.50 + 0.84 = 19.52) = 46.63 (46.64 from the unrounded volume).
