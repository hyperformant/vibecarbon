/**
 * Which file in carbon/cloud-init/k3s/ each k8s provider boots each node
 * role from, found by asking the providers rather than by a hand list. A
 * provider's getK8s<Role>UserData({}) is its template with the includes
 * resolved (loadCloudInit) and nothing substituted, so it equals exactly
 * one file's loadCloudInit. The censuses walk this, so a new provider, role
 * or script is checked the day it lands, and a script no provider boots
 * from is one they would never see.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCloudInit } from '../../src/lib/iac/cloud-init.js';
import { PROVIDERS } from '../../src/lib/providers/index.js';

export const K3S_DIR = join(__dirname, '../../carbon/cloud-init/k3s');

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

/** The providers with a k8s tier, by id. */
export const k8sProviderIds = (): string[] =>
  Object.entries(PROVIDERS)
    .filter(([, P]) => P.SUPPORTED_TIERS.includes('k8s'))
    .map(([id]) => id);

/**
 * Every k8s provider and node role, with the files whose template its user
 * data is: exactly one each, or a census over them would miss one.
 */
export async function k8sBootScripts(): Promise<
  { provider: string; role: Role; files: string[] }[]
> {
  const templates = bootScriptFiles().map((file) => [file, loadCloudInit(file)] as const);
  const out: { provider: string; role: Role; files: string[] }[] = [];
  for (const provider of k8sProviderIds()) {
    const P = PROVIDERS[provider] as unknown as UserDataGetters;
    for (const role of ROLES) {
      const userData = await P[GETTER[role]]({});
      out.push({
        provider,
        role,
        files: templates.filter(([, text]) => text === userData).map(([file]) => file),
      });
    }
  }
  return out;
}
