import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DigitalOceanProvider } from '../../../src/lib/providers/digitalocean.js';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

/**
 * All five providers boot the same Ubuntu release, or none do: the shell we run
 * on a server, its AppArmor profiles and its apt behaviour all follow the
 * release, so one provider left behind is a different product. Each provider
 * spells the release its own way, and the compose program repeats that
 * spelling, so the census names all of them in one place.
 */
const PROGRAMS = join(process.cwd(), 'src/lib/iac/programs');
const program = (file: string) => readFileSync(join(PROGRAMS, file), 'utf-8');

const FIVE = [
  ['hetzner', HetznerProvider, 'ubuntu-26.04', 'hetzner-compose.js', "image: 'ubuntu-26.04'"],
  [
    'digitalocean',
    DigitalOceanProvider,
    'ubuntu-26-04-x64',
    'digitalocean-compose.js',
    "image: 'ubuntu-26-04-x64'",
  ],
  [
    'linode',
    LinodeProvider,
    'linode/ubuntu26.04',
    'linode-compose.js',
    "image: 'linode/ubuntu26.04'",
  ],
  ['vultr', VultrProvider, '2760', 'vultr-compose.js', 'osId: 2760'],
  [
    'scaleway',
    ScalewayProvider,
    'ubuntu_resolute',
    'scaleway-compose.js',
    "image: 'ubuntu_resolute'",
  ],
] as const;

describe('every provider boots Ubuntu 26.04', () => {
  it.each(FIVE)(
    '%s: the compose image and its program agree',
    (_name, Provider, image, file, literal) => {
      expect(Provider.COMPOSE_IMAGE).toBe(image);
      expect(program(file)).toContain(literal);
    },
  );

  it('the k8s nodes boot the same release as compose', () => {
    expect(HetznerProvider.K8S_IMAGE).toBe(HetznerProvider.COMPOSE_IMAGE);
    expect(DigitalOceanProvider.K8S_IMAGE).toBe(DigitalOceanProvider.COMPOSE_IMAGE);
    for (const line of program('hetzner-k8s.js').split('\n')) {
      if (/^\s*image: '/.test(line)) expect(line).toContain("image: 'ubuntu-26.04'");
    }
  });
});
