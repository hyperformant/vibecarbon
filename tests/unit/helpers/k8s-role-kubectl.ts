/**
 * A k8s db pod's wal-g role surface, for failoverHA harnesses that drive the
 * real role code (setK8sWalgRole) and STEP 1's in-place reseed guard
 * (assertLiveDbGuardSupportsReseed) through their kubectl seam.
 *
 * `get pod db-0 -o json` answers a pod whose db container mounts the role
 * directory (unless `roleMount` is false: a cluster from before the role
 * mount), and an exec write into the role directory answers its read-back,
 * `WALG_ROLE_FILE=<the role in the script>`. Anything else is undefined, for
 * the caller's own stub to answer.
 */
export const WALG_ROLE_DIR = '/var/lib/vibecarbon/role';

export function k8sRoleReply(
  argv: string[],
  {
    roleMount = true,
    markerGrep = '1\nin_recovery=t',
    intent = 'standby',
  }: { roleMount?: boolean; markerGrep?: string; intent?: string } = {},
): string | undefined {
  const a = argv.join(' ');
  if (argv.includes('get') && argv.includes('pod') && argv.includes('db-0')) {
    // A db pod from this release: the db-guard.sh entrypoint and mount, the
    // role mount and the intent env, running (the in-place reseed guard).
    return JSON.stringify({
      metadata: { name: 'db-0', uid: 'db-0-uid' },
      spec: {
        containers: [
          {
            name: 'db',
            command: ['sh', '/usr/local/bin/db-guard.sh'],
            volumeMounts: [
              { name: 'data', mountPath: '/var/lib/postgresql/data', subPath: 'postgres-data' },
              { name: 'w', mountPath: '/usr/local/bin/db-guard.sh', subPath: 'db-guard.sh' },
              ...(roleMount
                ? [{ name: 'data', mountPath: WALG_ROLE_DIR, subPath: 'vibecarbon-role' }]
                : []),
            ],
            env: [
              {
                name: 'VC_WALG_ROLE_INTENT',
                valueFrom: {
                  configMapKeyRef: { name: 'vibecarbon-db-role', key: 'VC_WALG_ROLE_INTENT' },
                },
              },
            ],
          },
        ],
      },
      status: {
        containerStatuses: [
          {
            name: 'db',
            restartCount: 0,
            containerID: 'c1',
            ready: true,
            state: { running: {} },
          },
        ],
      },
    });
  }
  // The guard's intent read and its protocol-marker grep in the mounted wrapper.
  if (argv.includes('configmap') && a.includes('jsonpath={.data.VC_WALG_ROLE_INTENT}')) {
    return intent;
  }
  if (argv.includes('exec') && a.includes('grep -c') && a.includes('db-guard.sh')) {
    return markerGrep;
  }
  if (argv.includes('exec') && a.includes(WALG_ROLE_DIR)) {
    const role = /printf '%s\\n' (primary|standby) > walg-role\.tmp/.exec(a)?.[1] ?? '';
    return `WALG_ROLE_FILE=${role}\n`;
  }
  return undefined;
}

/** A kubectl seam answering only the role surface ('' for everything else). */
export const k8sRoleKubectl =
  (o: { roleMount?: boolean; markerGrep?: string; intent?: string } = {}) =>
  async (_ip: string, argv: string[]) =>
    k8sRoleReply(argv, o) ?? '';
