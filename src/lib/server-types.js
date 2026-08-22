/**
 * Server Type Selection Utilities
 *
 * Shared logic for building server type selection prompts used by
 * both the deploy and scale commands.
 */

// Minimum server specs for a full Compose stack (Supabase + app + Traefik + socket-proxy)
export const COMPOSE_MIN_RAM_GB = 4;

// Curated K8s deployment profiles — sensible combinations of master + supabase
// + worker. x86 only: vibecarbon standardizes on amd64 (see
// src/lib/deploy/platform.js), so the ARM variants these profiles used to carry
// — and the per-region `hasArm ? profile.arm : profile.x86` switch that made an
// EU cluster silently ARM — are gone.
//
// Each profile carries TWO x86 triples because Hetzner's shared-vCPU catalog is
// split by geography and generation (see HetznerProvider.FALLBACK_SERVER_TYPES):
//   - `types`         — the current `cpx*2` line, live in the EU (fsn1/nbg1/hel1).
//   - `fallbackTypes` — the legacy `cpx*1` line, which Hetzner made unorderable
//                       in the EU on 2026-01-01 but which remains the only
//                       shared-vCPU line sold in ash/hil.
// buildK8sProfileOptions picks the first triple fully available in the region's
// catalog. Before this split every profile named `cpx*1` unconditionally, so
// once the EU deprecation took effect all three profiles were filtered out in
// the default region and the prompt collapsed to "Advanced" only.
//
// NOT the `cx*3` line: it looks like the natural current-generation choice, but
// it reads `available: false` in all three EU locations, so profiles built on it
// pass the name check and then fail at provisioning. Availability is what
// matters here, and only the live catalog knows it — these names are the
// preference, HetznerProvider.isLocationOrderable is the arbiter.
export const K8S_PROFILES = [
  {
    name: 'starter',
    label: 'Starter',
    hint: 'Good for MVPs and low-traffic apps',
    types: { master: 'cpx22', supabase: 'cpx32', worker: 'cpx22' },
    fallbackTypes: { master: 'cpx11', supabase: 'cpx21', worker: 'cpx11' },
  },
  {
    name: 'production',
    label: 'Production',
    hint: 'Recommended for production workloads',
    types: { master: 'cpx32', supabase: 'cpx42', worker: 'cpx32' },
    fallbackTypes: { master: 'cpx21', supabase: 'cpx31', worker: 'cpx21' },
  },
  {
    name: 'enterprise',
    label: 'Enterprise',
    hint: 'High-traffic apps with large databases',
    types: { master: 'cpx42', supabase: 'cpx62', worker: 'cpx42' },
    fallbackTypes: { master: 'cpx31', supabase: 'cpx41', worker: 'cpx31' },
  },
];

/** Ordered candidate triples for a profile, most-preferred first. */
function profileVariants(profile) {
  return [profile.types, profile.fallbackTypes].filter(Boolean);
}

/**
 * Drop every non-amd64 server type from a provider catalog slice.
 *
 * THE chokepoint for "the CLI must never present an architecture choice".
 * Every option builder in this module runs its input through here, so a new
 * prompt inherits the guarantee by construction instead of having to remember
 * a filter of its own.
 *
 * Provider-agnostic by design: it reads the `architecture` each provider stamps
 * on its catalog entries (see `HetznerProvider.getServerTypesForRegion`) rather
 * than pattern-matching SKU names, so Hetzner's `cax*` naming never leaks into
 * shared code. Both spellings of the one architecture we support are accepted
 * ('x86' is Hetzner's API wording, 'amd64' the Docker/OCI one). Entries with no
 * `architecture` at all are kept — that's the DigitalOcean case, whose catalog
 * is 100% x86 (zero ARM instance types across all 31 size slugs).
 *
 * Note this filters what can be *selected*, not what can be *displayed*: a
 * pre-existing ARM environment still renders its current type fine everywhere
 * (status, the "Current Configuration" note, the select's `initialValue`),
 * it simply can no longer be re-picked from a list.
 *
 * @param {Array<{name: string, architecture?: string}>} types
 * @returns {Array<{name: string, architecture?: string}>}
 */
export function filterAmd64Types(types) {
  return types.filter(
    (t) => !t.architecture || t.architecture === 'x86' || t.architecture === 'amd64',
  );
}

/**
 * Format a server type label with aligned columns.
 * Pre-computes column widths from the full list so values line up.
 */
function buildAlignedLabels(types) {
  const nameW = Math.max(...types.map((t) => t.name.length));
  const vcpuW = Math.max(...types.map((t) => String(t.vcpu).length));
  const ramW = Math.max(...types.map((t) => String(t.ram).length));
  const diskW = Math.max(...types.map((t) => String(t.disk).length));

  return new Map(
    types.map((t) => [
      t.name,
      `${t.name.padEnd(nameW)} - ${String(t.vcpu).padStart(vcpuW)} vCPU, ${String(t.ram).padStart(ramW)}GB RAM, ${String(t.disk).padStart(diskW)}GB`,
    ]),
  );
}

/**
 * Build select options for Compose server type prompt.
 * Disables types that are too small, marks minimum and recommended.
 * amd64 only — see filterAmd64Types.
 */
export function buildComposeTypeOptions(regionTypes, defaultType) {
  const filtered = filterAmd64Types(regionTypes).filter(
    (t) => !t.cpuType || t.cpuType === 'shared',
  );
  const labels = buildAlignedLabels(filtered);

  return filtered.map((t) => {
    const tooSmall = t.ram < COMPOSE_MIN_RAM_GB;
    const isMinimum = !tooSmall && t.ram === COMPOSE_MIN_RAM_GB && t.disk <= 40;
    const isRecommended = t.name === defaultType;

    let hint = '';
    if (tooSmall) {
      hint = `need ${COMPOSE_MIN_RAM_GB}GB+ RAM for Supabase`;
    } else if (isMinimum) {
      hint = 'minimum';
    } else if (isRecommended) {
      hint = 'recommended';
    }

    return {
      value: t.name,
      label: labels.get(t.name),
      hint,
      disabled: tooSmall,
    };
  });
}

/**
 * Build select options for K8s cluster size profiles.
 *
 * The region catalog is filtered to amd64 before the availability check, so a
 * region that carries ARM SKUs can no longer make an ARM profile "available"
 * (the old `hasArm ? profile.arm : profile.x86` switch did exactly that in
 * fsn1/hel1/nbg1).
 */
export function buildK8sProfileOptions(regionTypes) {
  const availableNames = new Set(filterAmd64Types(regionTypes).map((t) => t.name));

  return K8S_PROFILES.map((profile) => {
    // First triple fully stocked in this region wins: the current `cpx*2`
    // generation in the EU, the legacy `cpx*1` line in ash/hil. A profile is
    // only dropped when NEITHER generation is fully available.
    const variant = profileVariants(profile).find((v) =>
      [v.master, v.supabase, v.worker].every((t) => availableNames.has(t)),
    );
    if (!variant) return null;

    return {
      value: profile.name,
      label: profile.label,
      hint: `${profile.hint} (${variant.master} + ${variant.supabase} + ${variant.worker})`,
      _variant: variant,
    };
  })
    .filter(Boolean)
    .concat([
      {
        value: 'advanced',
        label: 'Advanced',
        hint: 'Choose each node type individually',
        _variant: null,
      },
    ]);
}

/**
 * Detect which K8s profile matches the given server types.
 * Returns the profile name or 'advanced' if no match.
 *
 * A pre-existing ARM cluster (provisioned before the x86-64 standardization)
 * now classifies as 'advanced' rather than matching a named profile — the
 * honest answer, since no offered profile describes it. It still renders: the
 * caller displays the raw current types alongside this label, so nothing goes
 * blank; the operator simply can't re-pick that shape from the profile list.
 */
export function detectCurrentProfile(masterType, supabaseType, workerType) {
  for (const profile of K8S_PROFILES) {
    // Either generation counts — a cluster provisioned in ash/hil runs the
    // legacy cpx*1 trio and should still classify as its named profile.
    for (const v of profileVariants(profile)) {
      if (v.master === masterType && v.supabase === supabaseType && v.worker === workerType) {
        return profile.name;
      }
    }
  }
  return 'advanced';
}

/**
 * Build a flat list of server type select options.
 * Used for K8s Advanced mode individual node selection and the scale command.
 *
 * `filterSharedCpu: false` (scale's per-role pickers) opts out of the
 * shared-vCPU filter ONLY. The amd64 filter is not optional — this builder fed
 * scale's master/supabase/worker `select()` prompts with the region catalog
 * verbatim, which is how ARM types appeared in the picker for any region that
 * had them.
 *
 * @param {Array} regionTypes - from Provider.getServerTypesForRegion()
 * @param {object} [options]
 * @param {boolean} [options.filterSharedCpu=true] - filter to shared CPU types only
 * @returns {Array<{value: string, label: string}>}
 */
export function buildSimpleTypeOptions(regionTypes, { filterSharedCpu = true } = {}) {
  const amd64 = filterAmd64Types(regionTypes);
  const filtered = filterSharedCpu
    ? amd64.filter((t) => !t.cpuType || t.cpuType === 'shared')
    : amd64;

  const labels = buildAlignedLabels(filtered);

  return filtered.map((t) => ({
    value: t.name,
    label: labels.get(t.name),
  }));
}
