/**
 * A k8s db pod's wal-g role surface, for failoverHA harnesses that drive the
 * real role code (setK8sWalgRole) through their kubectl seam.
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
  { roleMount = true }: { roleMount?: boolean } = {},
): string | undefined {
  const a = argv.join(' ');
  if (argv.includes('get') && argv.includes('pod') && argv.includes('db-0')) {
    return JSON.stringify({
      metadata: { name: 'db-0', uid: 'db-0-uid' },
      spec: {
        containers: [
          {
            name: 'db',
            volumeMounts: [
              { name: 'data', mountPath: '/var/lib/postgresql/data', subPath: 'postgres-data' },
              ...(roleMount
                ? [{ name: 'data', mountPath: WALG_ROLE_DIR, subPath: 'vibecarbon-role' }]
                : []),
            ],
          },
        ],
      },
    });
  }
  if (argv.includes('exec') && a.includes(WALG_ROLE_DIR)) {
    const role = /printf '%s\\n' (primary|standby) > walg-role\.tmp/.exec(a)?.[1] ?? '';
    return `WALG_ROLE_FILE=${role}\n`;
  }
  return undefined;
}

/** A kubectl seam answering only the role surface ('' for everything else). */
export const k8sRoleKubectl =
  (o: { roleMount?: boolean } = {}) =>
  async (_ip: string, argv: string[]) =>
    k8sRoleReply(argv, o) ?? '';
