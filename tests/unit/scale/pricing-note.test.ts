/**
 * String-drift guard for scale.js's two "Current <provider> pricing: <url>"
 * notes.
 *
 * These lines are user-facing cost disclosures shown before a scale
 * operation. Task C1 hoisted the pricing URL from a standalone
 * `HETZNER_PRICING_URL` export onto `HetznerProvider.PRICING_URL`. R9
 * (task A6) went further and derives BOTH the provider name and the URL
 * from `providerFor(envConfig)` — a sanctioned deviation from the old
 * literal "Current Hetzner pricing" wording (HetznerProvider.NAME is
 * 'Hetzner Cloud', not 'Hetzner'; see
 * tests/unit/cli/provider-neutral-strings.test.ts for the consolidated R9
 * pin). This test pins the exact rendered output for the Hetzner case so a
 * future refactor can't silently change what the user sees again.
 */
import { describe, expect, it } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { readRepoFile } from '../../_shared/source-files.js';

const SCALE_SRC = readRepoFile('src/scale.js');

describe('scale.js pricing note — exact string pin', () => {
  it('both note call sites interpolate Provider.NAME and Provider.PRICING_URL', () => {
    const pattern =
      /p\.note\(`Current \$\{Provider\.NAME\} pricing: \$\{link\(Provider\.PRICING_URL\)\}`, 'Cost'\)/g;
    const occurrences = SCALE_SRC.match(pattern) || [];
    expect(occurrences).toHaveLength(2);
  });

  it('renders to the exact expected line for Hetzner (compose-tier and k8s-tier notes)', () => {
    const rendered = `Current ${HetznerProvider.NAME} pricing: ${HetznerProvider.PRICING_URL}`;
    expect(rendered).toBe('Current Hetzner Cloud pricing: https://www.hetzner.com/cloud/');
  });
});
