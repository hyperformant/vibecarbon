/**
 * DO-CSI stale-VolumeAttachment signature (d4 run 6, 2026-08-28).
 *
 * Live evidence: k8s VolumeAttachments said `attached: true` while
 * DigitalOcean's API showed the volumes attached to NO droplet; NodeStage
 * probed the missing device as unformatted and ran `mkfs.ext4` against a path
 * that does not exist, forever. The reseed no longer churns the db volume (it
 * restarts the db container in place, Task A4), so its detach waits and
 * stale-attachment repair are gone; the signature stays, because
 * persistentStaleAttach (watchDbAttach's diagnosis) reads it.
 */
import { describe, expect, it } from 'vitest';
import { STALE_ATTACH_EVENT_PATTERN } from '../../../src/lib/deploy/replication.js';

describe('STALE_ATTACH_EVENT_PATTERN', () => {
  it('matches the live kubelet event verbatim', () => {
    const live =
      'MountVolume.MountDevice failed for volume "pvc-d37e3ce6" : rpc error: code = Internal ' +
      "desc = formatting disk failed: exit status 1 cmd: 'mkfs.ext4 -F /dev/disk/by-id/..." +
      '\' output: "mke2fs 1.46.6\\nThe file /dev/disk/by-id/scsi-0DO_Volume_pvc-d37e3ce6 ' +
      'does not exist and no size was specified.\\n"';
    expect(STALE_ATTACH_EVENT_PATTERN.test(live)).toBe(true);
  });

  it('does not match ordinary mount noise', () => {
    expect(STALE_ATTACH_EVENT_PATTERN.test('Unable to attach or mount volumes: timed out')).toBe(
      false,
    );
  });
});
