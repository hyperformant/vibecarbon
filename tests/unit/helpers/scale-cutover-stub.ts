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
  return { ...actual, loadProjectConfig: () => null, saveProjectConfig: () => {} };
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
  };
}
