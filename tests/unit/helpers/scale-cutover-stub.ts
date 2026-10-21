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
