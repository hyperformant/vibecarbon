/**
 * Each e2e project makes its own state passphrase. An inherited one (from a
 * shell that works on another project, or a Pulumi export) would be adopted
 * by the first command that opens a stack and tie the run to a passphrase the
 * scenario never made.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { e2eCliEnv } from '../../e2e/utils/e2e-env.js';

afterEach(() => vi.unstubAllEnvs());

describe('e2eCliEnv state passphrase scrub', () => {
  const inherited = {
    VIBECARBON_STATE_PASSPHRASE: 'another-projects-state-passphrase-0123456789abcdef',
    PULUMI_CONFIG_PASSPHRASE: 'another-projects-passphrase',
    PULUMI_CONFIG_PASSPHRASE_FILE: '/home/someone/other-passphrase',
    OTHER: 'kept',
  };

  it('drops all three from the inherited environment', () => {
    const env = e2eCliEnv({}, inherited);
    expect(env.VIBECARBON_STATE_PASSPHRASE).toBeUndefined();
    expect(env.PULUMI_CONFIG_PASSPHRASE).toBeUndefined();
    expect(env.PULUMI_CONFIG_PASSPHRASE_FILE).toBeUndefined();
    expect(env.OTHER).toBe('kept');
  });

  it('drops them from the default process environment too', () => {
    vi.stubEnv('VIBECARBON_STATE_PASSPHRASE', inherited.VIBECARBON_STATE_PASSPHRASE);
    vi.stubEnv('PULUMI_CONFIG_PASSPHRASE', inherited.PULUMI_CONFIG_PASSPHRASE);
    vi.stubEnv('PULUMI_CONFIG_PASSPHRASE_FILE', inherited.PULUMI_CONFIG_PASSPHRASE_FILE);
    const env = e2eCliEnv();
    expect(Object.keys(env)).not.toContain('VIBECARBON_STATE_PASSPHRASE');
    expect(Object.keys(env)).not.toContain('PULUMI_CONFIG_PASSPHRASE');
    expect(Object.keys(env)).not.toContain('PULUMI_CONFIG_PASSPHRASE_FILE');
  });

  it('a scenario can still pass one explicitly', () => {
    const env = e2eCliEnv({ VIBECARBON_STATE_PASSPHRASE: 'explicit' }, inherited);
    expect(env.VIBECARBON_STATE_PASSPHRASE).toBe('explicit');
  });
});
