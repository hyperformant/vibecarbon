import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock runCommand BEFORE the destroy module loads so the real one
// (which would actually shell out to kubectl) never runs.
const runCommandMock = vi.fn();

vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    runCommand: (...args: unknown[]) => runCommandMock(...args),
  };
});

import { cleanupClusterPVCs } from '../../../src/destroy.js';

describe('cleanupClusterPVCs', () => {
  let tmpDir: string;
  let kubeconfigPath: string;

  beforeEach(() => {
    runCommandMock.mockReset();
    tmpDir = mkdtempSync(join(tmpdir(), 'vc-csi-pvc-cleanup-'));
    kubeconfigPath = join(tmpDir, 'kubeconfig-prod');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-ops when kubeconfig file does not exist (cluster never came up)', async () => {
    await cleanupClusterPVCs(kubeconfigPath);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('deletes the vibecarbon namespace cascade — controllers, pods, PVCs, PVs in dependency order', async () => {
    writeFileSync(kubeconfigPath, 'apiVersion: v1\nkind: Config\n');
    runCommandMock.mockReturnValue(true);

    await cleanupClusterPVCs(kubeconfigPath);

    expect(runCommandMock).toHaveBeenCalledTimes(1);

    // Single namespace-delete with --wait=true so we don't fall through
    // to Pulumi destroy while CSI is still finalizing PV deletion.
    const [args] = runCommandMock.mock.calls[0];
    expect(args).toEqual([
      'kubectl',
      '--kubeconfig',
      kubeconfigPath,
      'delete',
      'namespace',
      'vibecarbon',
      '--wait=true',
      '--timeout=240s',
      '--ignore-not-found=true',
    ]);
  });

  it('passes ignoreError + silent so a wedged cluster does not abort the destroy', async () => {
    writeFileSync(kubeconfigPath, 'apiVersion: v1\nkind: Config\n');
    runCommandMock.mockReturnValue(true);

    await cleanupClusterPVCs(kubeconfigPath);

    for (const call of runCommandMock.mock.calls) {
      const [, options] = call;
      expect(options).toMatchObject({ ignoreError: true, silent: true });
    }
  });

  it('does not throw when kubectl itself errors (best-effort: post-destroy sweep is the safety net)', async () => {
    writeFileSync(kubeconfigPath, 'apiVersion: v1\nkind: Config\n');
    runCommandMock.mockImplementation(() => {
      throw new Error('connection refused');
    });

    await expect(cleanupClusterPVCs(kubeconfigPath)).resolves.toBeUndefined();
  });
});
