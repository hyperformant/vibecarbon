/**
 * Which file in carbon/cloud-init/k3s/ each k8s provider boots each node
 * role from, found by asking the providers rather than by a hand list. A
 * provider's getK8s<Role>UserData({}) is its template loaded for the role
 * (loadCloudInit: includes resolved, role slots filled) with nothing
 * substituted but what the static adds itself (a master's CSI image
 * rewrites, csiImageRewriteVars), so it equals exactly one file loaded and
 * filled that way. The db node
 * has no script of its own: it loads its provider's worker script as the db
 * role. The censuses walk this, so a new provider, role or script is checked
 * the day it lands, and a script no provider boots from is one they would
 * never see.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { csiImageRewriteVars, loadCloudInit, renderScript } from '../../src/lib/iac/cloud-init.js';
import { CSI_SIDECAR_MIRRORS } from '../../src/lib/images.js';
import { PROVIDERS } from '../../src/lib/providers/index.js';
import { k8sCensusProviders } from './k8s-built-ahead.js';

const K3S_DIR = join(__dirname, '../../carbon/cloud-init/k3s');

export const ROLES = ['master', 'worker', 'db'] as const;
export type Role = (typeof ROLES)[number];

type UserDataGetters = Record<
  `getK8s${'Master' | 'Worker' | 'Db'}UserData`,
  (vars: object) => Promise<string>
>;
const GETTER = {
  master: 'getK8sMasterUserData',
  worker: 'getK8sWorkerUserData',
  db: 'getK8sDbUserData',
} as const;

/** The boot scripts, the files an include pulls in (`_` first) left out. */
export const bootScriptFiles = (): string[] =>
  readdirSync(K3S_DIR)
    .filter((f) => f.endsWith('.sh') && !f.startsWith('_'))
    .sort();

/**
 * `file` loaded the way a node of `role` boots it: the db node's role fills
 * the worker script's role slots with its labels and taint. Null when the
 * file cannot load that way (a master script has no role slots).
 */
export function loadBootScript(file: string, role: Role): string | null {
  try {
    return loadCloudInit(file, { role: role === 'db' ? 'db' : 'worker' });
  } catch {
    return null;
  }
}

/** The providers with a k8s tier, and those whose boot scripts are built ahead of it, by id. */
const k8sProviderIds = (): string[] => k8sCensusProviders('boot').map(([id]) => id);

/**
 * Every k8s provider and node role, with its user data (nothing
 * substituted) and the files whose template it is: exactly one each, or a
 * census over them would miss one.
 */
export async function k8sBootScripts(): Promise<
  { provider: string; role: Role; files: string[]; userData: string }[]
> {
  const out: { provider: string; role: Role; files: string[]; userData: string }[] = [];
  for (const provider of k8sProviderIds()) {
    const P = PROVIDERS[provider] as unknown as UserDataGetters;
    for (const role of ROLES) {
      const userData = await P[GETTER[role]]({});
      // A provider built ahead of its CSI part has no image rewrites yet
      // (csiImageRewriteVars throws), and its master names none.
      const added =
        role === 'master' && Object.hasOwn(CSI_SIDECAR_MIRRORS, provider)
          ? csiImageRewriteVars(provider)
          : {};
      const files = bootScriptFiles().filter((file) => {
        const script = loadBootScript(file, role);
        return script !== null && renderScript(script, added) === userData;
      });
      out.push({ provider, role, files, userData });
    }
  }
  return out;
}
