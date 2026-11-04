/**
 * The compose scale cutover's remote steps, stubbed for scale tests that test
 * something else (provisioning, IP resolution, the listing). The fence, its
 * rollback and the cron removal are covered by compose-scale-fence.test.ts.
 */
export function stubScaleCutover<T extends Record<string, unknown>>(
  actual: T,
  onFence: () => void = () => {},
) {
  return {
    ...actual,
    fenceComposePrimary: async () => {
      onFence();
      return {
        switchWal: '000000010000000000000003',
        stopped: [] as string[],
        fencedAt: new Date(),
      };
    },
    removeComposeBackupCron: async () => {},
    rollbackComposeCutover: async () => ({ ok: true, problems: [] as string[] }),
  };
}

/** The old primary's demote, stubbed as landed. */
export function stubDemote<T extends Record<string, unknown>>(actual: T) {
  return { ...actual, demoteComposeWalgRole: async () => true };
}

/**
 * The write-fence marker and cutover journal, stubbed: they write the
 * project config, which these tests do not have.
 */
export function stubWriteFence<T extends Record<string, unknown>>(actual: T) {
  return {
    ...actual,
    writeWriteFenceMarker: () => {},
    clearWriteFenceMarker: () => {},
    writeScaleCutoverJournal: () => {},
    markScaleCutoverStep: () => {},
    clearScaleCutoverJournal: () => {},
  };
}

/** The project config, stubbed: no file is read or written. */
export function stubProjectConfig<T extends Record<string, unknown>>(actual: T) {
  return { ...actual, loadProjectConfig: () => null, updateProjectConfig: () => ({}) };
}

/**
 * The Pulumi state sync after a scale (server-state-sync.js), stubbed: it
 * writes the project config and the state backend. `onEvent` sees
 * `state:record:<stack>:<id>` and `state:sync:<stack>:<id>`.
 */
export function stubServerStateSync<T extends Record<string, unknown>>(
  actual: T,
  onEvent: (event: string) => void = () => {},
) {
  return {
    ...actual,
    recordPendingServerState: (_env: string, e: { stack: string; serverId: unknown }) => {
      onEvent(`state:record:${e.stack}:${e.serverId}`);
    },
    syncScaledServerState: async (_ctx: unknown, e: { stack: string; serverId: unknown }) => {
      onEvent(`state:sync:${e.stack}:${e.serverId}`);
    },
    markPendingServerOldDeleted: (_env: string, stack: string) => {
      onEvent(`state:old-deleted:${stack}`);
    },
  };
}

/**
 * The role a compose wal-g role-file write sets (writeComposeWalgRole sends
 * `sh -c <composeWalgRoleWriteShell>` through ssh.js's sshRun), or null for
 * any other argv.
 */
export function roleWriteOf(argv: string[]): 'primary' | 'standby' | null {
  const script = argv[0] === 'sh' && argv[1] === '-c' ? (argv[2] ?? '') : '';
  if (!script.includes('.vibecarbon-role')) return null;
  const m = /printf '%s\\n' (primary|standby) > walg-role\.tmp/.exec(script);
  return (m?.[1] as 'primary' | 'standby' | undefined) ?? null;
}

/**
 * An ssh.js sshRun answer: a role-file write reads back the role it wrote
 * (and is reported through `onRole`); anything else answers ''.
 */
export function answerRoleWrite(onRole: (ip: string, role: string) => void = () => {}) {
  return (ip: string, argv: string[]) => {
    const role = roleWriteOf(argv);
    if (!role) return '';
    onRole(ip, role);
    return `WALG_ROLE_FILE=${role}`;
  };
}
