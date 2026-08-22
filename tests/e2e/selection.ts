// The e2e selection grammar. Scenario identity is `provider/mode` everywhere;
// env prefixes are internal namespacing and never selection vocabulary.
// Pre-release clean break: legacy bare-mode and d1/d2/d3 tokens throw.
import { testConfig } from '../config.js';

export class SelectionError extends Error {}

export interface SelectedScenario {
  provider: string;
  mode: string;
  dnsProvider: string;
  envPrefix: string;
}

interface Token {
  provider: string;
  mode: string;
  dnsProvider?: string;
}

const registry = () =>
  testConfig.e2e.providers as unknown as Record<
    string,
    {
      requiredEnv: string[];
      scenarios: { mode: string; dnsProvider: string; envPrefix: string }[];
      defaultSelection: string[];
    }
  >;

function knownProviders(): string[] {
  return Object.keys(registry());
}

/**
 * DNS providers selectable as a `-dnsProvider` refinement.
 *
 * Sourced from the domains map, NOT from the scenarios' own dnsProvider
 * values: a refinement is viable exactly when we hold a base domain for that
 * backend, which is the condition resolveBaseDomain enforces at run time.
 *
 * Deriving it from registered rows instead made every scenario's DNS a closed
 * set — once each provider defaulted to its own native DNS, cloudflare stopped
 * being registered anywhere it could still legitimately be asked for, and
 * `hetzner/k8s-ha-cloudflare` became unparseable. Any backend with a domain is
 * an option on any scenario; the registry rows only decide the DEFAULT.
 */
function getAllDnsProviders(): string[] {
  return Object.keys(testConfig.e2e.domains as Record<string, string>);
}

function parseToken(tok: string): Token {
  // Lowercase the token for case-insensitive parsing
  const lowerTok = tok.toLowerCase();

  // Build regex dynamically from registry dnsProvider values
  const dnsProviders = getAllDnsProviders();
  const dnsAlt = dnsProviders.join('|');
  const regex = new RegExp(`^([a-z0-9-]+)\\/([a-z0-9-]+?)(?:-(${dnsAlt}))?$`);

  const m = regex.exec(lowerTok);
  if (!m || !registry()[m[1]]) {
    if (lowerTok.includes('/')) {
      const provider = lowerTok.split('/')[0];
      if (registry()[provider]) {
        // Provider is known but token is malformed
        throw new SelectionError(
          `invalid scenario token '${tok}' — use provider/mode (e.g. hetzner/k8s-ha, ` +
            `digitalocean/compose) or provider/mode-dnsProvider`,
        );
      } else {
        // Provider is unknown
        throw new SelectionError(
          `unknown provider '${provider}' (known: ${knownProviders().join(', ')}, all)`,
        );
      }
    }
    throw new SelectionError(
      `invalid scenario token '${tok}' — use provider/mode (e.g. hetzner/k8s-ha, ` +
        `digitalocean/compose) or provider/mode-dnsProvider`,
    );
  }
  const [, provider, mode, dnsProvider] = m;
  const entry = registry()[provider];
  if (!entry.scenarios.some((s) => s.mode === mode)) {
    throw new SelectionError(
      `${provider} does not support ${mode} (supported: ${entry.scenarios
        .map((s) => s.mode)
        .join(', ')})`,
    );
  }

  // No dnsProvider validation here, deliberately. The regex alternation above
  // is built from the same getAllDnsProviders() list, so an id we hold no base
  // domain for can never reach this point as a captured refinement — the
  // non-greedy mode group swallows it and the unsupported-MODE error fires
  // instead. A check here would be unreachable code implying a guard that
  // never runs. selection-grammar.test.ts pins that absorption behaviour.
  //
  // Any backend WITH a base domain is allowed on any scenario: the registry
  // row supplies the DEFAULT, not the only permissible choice.

  return { provider, mode, dnsProvider };
}

/**
 * Scenario identity is `provider/mode`. DNS is NOT part of identity — it is an
 * override carried by the token, applied after the match (see resolveSelection).
 *
 * Matching on dnsProvider as well would mean a refinement could only ever
 * re-select the row's existing default: `digitalocean/compose-cloudflare` would
 * match nothing and silently yield an EMPTY selection, which reads as "ran
 * fine, zero scenarios" rather than an error.
 */
function scenarioMatches(provider: string, s: { mode: string }, t: Token) {
  return provider === t.provider && s.mode === t.mode;
}

export function resolveSelection(opts: {
  providers?: string[];
  include?: string[];
  exclude?: string[];
}): SelectedScenario[] {
  const reg = registry();
  const provArg = (opts.providers ?? []).map((p) => p.toLowerCase());
  for (const p of provArg) {
    if (p !== 'all' && !reg[p]) {
      throw new SelectionError(
        `unknown provider '${p}' (known: ${knownProviders().join(', ')}, all)`,
      );
    }
  }
  const include = (opts.include ?? []).map(parseToken);
  const exclude = (opts.exclude ?? []).map(parseToken);

  // DNS is an override applied to an INCLUDED scenario, so it cannot also act
  // as an exclusion discriminator — `--except hetzner/k8s-ha-hetzner` would
  // either drop the whole scenario or nothing, and which one it meant is not
  // recoverable from the token. Refuse it rather than pick silently.
  for (const t of exclude) {
    if (t.dnsProvider) {
      throw new SelectionError(
        `'${t.provider}/${t.mode}-${t.dnsProvider}' — a DNS refinement is an override and ` +
          `cannot be excluded; drop the '-${t.dnsProvider}' and exclude ${t.provider}/${t.mode}`,
      );
    }
  }

  // Which providers are in play?
  //
  // There is NO default provider. A bare run used to fall back to whichever
  // provider carried `releaseGating: true` — a flag that gated no release
  // (nothing consumed it but this line; release.yml fires on the unit/
  // integration Test Suite, never on e2e) and that quietly made one provider
  // the privileged one. Every provider is equal here, so the caller has to
  // say which they mean: `--provider <id>`, `--provider all`, or a
  // self-qualifying `provider/mode` token.
  if (provArg.length === 0 && include.length === 0) {
    throw new SelectionError(
      `no provider selected — pass --provider <${knownProviders().join('|')}|all>, ` +
        `or name scenarios directly (e.g. hetzner/compose, digitalocean/k8s). ` +
        `There is deliberately no default: no provider is privileged.`,
    );
  }
  const poolProviders: string[] = provArg.includes('all')
    ? knownProviders()
    : provArg.length > 0
      ? provArg
      : knownProviders(); // include list is self-qualifying

  // Include tokens must live inside the explicit provider pool when one was given.
  if (provArg.length > 0 && !provArg.includes('all')) {
    for (const t of include) {
      if (!provArg.includes(t.provider)) {
        throw new SelectionError(
          `scenario '${t.provider}/${t.mode}' is outside --provider ${provArg.join(',')}`,
        );
      }
    }
  }

  const out: SelectedScenario[] = [];
  for (const providerName of knownProviders()) {
    if (!poolProviders.includes(providerName)) continue;
    const entry = reg[providerName];
    for (const s of entry.scenarios) {
      const inDefaults = entry.defaultSelection.includes(s.mode);
      const matchedInclude = include.find((t) => scenarioMatches(providerName, s, t));
      const included = include.length > 0 ? Boolean(matchedInclude) : inDefaults;
      if (!included) continue;
      if (exclude.some((t) => scenarioMatches(providerName, s, t))) continue;
      out.push({
        provider: providerName,
        mode: s.mode,
        // The token's refinement wins; the registry row supplies the default.
        dnsProvider: matchedInclude?.dnsProvider ?? s.dnsProvider,
        envPrefix: s.envPrefix,
      });
    }
  }
  return out;
}
