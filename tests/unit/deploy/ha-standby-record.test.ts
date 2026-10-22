/**
 * A redeploy never resizes or refuses an existing k8s-ha env: the standby's
 * master and db types are read back from `ha.standby` (and its worker from
 * `ha.standbyWorkerSpec`), whether or not the side carries a stack identity
 * yet (a first deploy that failed after the skeleton save has types but no
 * stack). After a failover the record follows the role: the new standby is
 * the old primary, with the old primary's types.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/ssh.js')>()),
  getPostgresPod: vi.fn(async () => 'db-0'),
  sshKubectl: vi.fn(async () => ''),
}));

const { haStacksFrom } = await import('../../../src/lib/deploy/standby-types.js');
const { swapHaRoles } = await import('../../../src/failover.js');

describe('haStacksFrom', () => {
  it('no ha record: null', () => {
    expect(haStacksFrom({})).toBeNull();
    expect(haStacksFrom(undefined)).toBeNull();
  });

  it('types on record without a stack still ride along; no stack or region is invented', () => {
    const stacks = haStacksFrom({
      ha: {
        standby: { masterServerType: 'cpx22', dbServerType: 'cpx12' },
        standbyWorkerSpec: { count: 1, serverType: 'cpx22' },
      },
    });
    expect(stacks?.standby).toEqual({
      masterServerType: 'cpx22',
      dbServerType: 'cpx12',
      workerServerType: 'cpx22',
    });
    expect(stacks?.primary).toEqual({});
  });

  it('a full record carries stack, region and types per side', () => {
    const stacks = haStacksFrom({
      ha: {
        primary: {
          stack: 'prod-primary',
          region: 'nbg1',
          masterServerType: 'cpx22',
          dbServerType: 'cpx12',
        },
        standby: {
          stack: 'prod-standby',
          region: 'fsn1',
          masterServerType: 'cpx32',
          dbServerType: 'cpx22',
        },
      },
    });
    expect(stacks).toEqual({
      primary: {
        stack: 'prod-primary',
        region: 'nbg1',
        masterServerType: 'cpx22',
        dbServerType: 'cpx12',
      },
      standby: {
        stack: 'prod-standby',
        region: 'fsn1',
        masterServerType: 'cpx32',
        dbServerType: 'cpx22',
      },
    });
  });

  it('stack and region stay paired: one side without a stack keeps both sides unstacked', () => {
    const stacks = haStacksFrom({
      ha: {
        primary: { stack: 'prod-primary', region: 'nbg1' },
        standby: { region: 'fsn1', masterServerType: 'cpx22' },
      },
    });
    expect(stacks?.primary).toEqual({});
    expect(stacks?.standby).toEqual({ masterServerType: 'cpx22' });
  });
});

describe('after swapHaRoles the record follows the role', () => {
  let dir: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('the new standby carries the old primary types', () => {
    dir = mkdtempSync(join(tmpdir(), 'vc-standby-record-'));
    writeFileSync(
      join(dir, '.vibecarbon.json'),
      JSON.stringify({
        projectName: 'myapp',
        environments: {
          prod: {
            region: 'nbg1',
            secondaryRegion: 'fsn1',
            ha: {
              enabled: true,
              primary: {
                stack: 'prod-primary',
                region: 'nbg1',
                masterServerType: 'cpx32',
                dbServerType: 'cpx22',
              },
              standby: {
                stack: 'prod-standby',
                region: 'fsn1',
                masterServerType: 'cpx22',
                dbServerType: 'cpx12',
              },
            },
          },
        },
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    swapHaRoles('prod');
    const env = JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8')).environments.prod;
    const stacks = haStacksFrom(env);
    expect(stacks?.standby).toEqual({
      stack: 'prod-primary',
      region: 'nbg1',
      masterServerType: 'cpx32',
      dbServerType: 'cpx22',
    });
    expect(stacks?.primary).toMatchObject({ stack: 'prod-standby', masterServerType: 'cpx22' });
  });
});
