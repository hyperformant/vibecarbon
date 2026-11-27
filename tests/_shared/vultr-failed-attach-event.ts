/**
 * The Warning event that held db-0 Pending for the whole 900 s db rollout wait
 * in perf run 45940611622 (vultr/k8s, step restore-deploy), as the e2e
 * failure bundle recorded it: `Warning FailedAttachVolume (x15 over 15m)
 * attachdetach-controller`. Shared by the db rollout failure's tests and the
 * classifier's, so no test file imports another.
 */

export const FAILED_ATTACH_MESSAGE =
  'AttachVolume.Attach failed for volume "pvc-8d578e6fd25c44b0" : rpc error: code = Internal ' +
  'desc = ControllerPublishVolume: cannot attach volume to node: storage handler unable to ' +
  'attach block storage : {"error":"Block storage is not compatible with this server","status":400}';

/** The current db-0's uid in these fixtures. */
export const DB_POD_UID = '6b0f3c2e-1d6a-4f7e-9a51-2f0e8d1c4b7a';

/**
 * The event as `kubectl get events -o json` lists it: core/v1, written by the
 * attachdetach-controller's legacy recorder, so it counts its repeats and
 * bumps lastTimestamp (eventTime stays null).
 */
export const failedAttachEvent = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 'v1',
  kind: 'Event',
  metadata: {
    name: 'db-0.187b9c0e5f3a2d11',
    namespace: 'vibecarbon',
    creationTimestamp: '2026-11-27T04:58:41Z',
  },
  involvedObject: {
    apiVersion: 'v1',
    kind: 'Pod',
    namespace: 'vibecarbon',
    name: 'db-0',
    uid: DB_POD_UID,
  },
  reason: 'FailedAttachVolume',
  message: FAILED_ATTACH_MESSAGE,
  source: { component: 'attachdetach-controller' },
  firstTimestamp: '2026-11-27T04:58:41Z',
  lastTimestamp: '2026-11-27T05:13:47Z',
  count: 15,
  type: 'Warning',
  eventTime: null,
  reportingComponent: 'attachdetach-controller',
  reportingInstance: '',
  ...overrides,
});
