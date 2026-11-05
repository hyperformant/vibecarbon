/**
 * Per-resource timing for one Pulumi `up`, built from the engine event stream
 * (`stack.up({ onEvent })`). Pairs `resourcePreEvent` with `resOutputsEvent`
 * by URN and reports one `[perf] <stem>.resource.<Type>.<name> <ms>ms` line
 * per resource the update really changed, plus
 * `<stem>.resource.firstEvent`: the time from `begin()` to the first engine
 * event, i.e. Pulumi's own startup and plugin load.
 *
 * Instrumentation only: every entry point swallows its own errors, because a
 * timing bug must never fail a deploy.
 */

import { perfRecord } from '../perf.js';

const TIMED_OPS = new Set(['create', 'update', 'replace', 'create-replacement']);

/** `urn:pulumi:stack::project::a:b$c:d:Type::name` -> the Type segment and the name. */
function describeUrn(urn, type) {
  const parts = String(urn).split('::');
  const name = (parts.at(-1) ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  const typeToken = String(type || parts.at(-2) || '')
    .split('$')
    .at(-1)
    .split(':')
    .at(-1)
    .replace(/[^A-Za-z0-9]/g, '');
  return { type: typeToken, name };
}

/**
 * @param {{ stem: string, now?: () => number, record?: (name: string, ms: number) => void }} opts
 */
export function createResourceTimer({ stem, now = Date.now, record = perfRecord }) {
  const pending = new Map();
  let beganAt = null;
  let firstSeen = false;

  const guard = (fn) => {
    try {
      fn();
    } catch {
      // timing must never fail a deploy
    }
  };

  return {
    /** Call right before each `stack.up` attempt; a retry starts clean. */
    begin() {
      beganAt = now();
      pending.clear();
    },
    onEvent(event) {
      guard(() => {
        if (!firstSeen && beganAt !== null) {
          firstSeen = true;
          record(`${stem}.resource.firstEvent`, now() - beganAt);
        }
        const pre = event?.resourcePreEvent?.metadata;
        if (pre?.urn && TIMED_OPS.has(pre.op) && pre.type !== 'pulumi:pulumi:Stack') {
          pending.set(pre.urn, now());
          return;
        }
        const done = event?.resOutputsEvent?.metadata;
        if (!done?.urn || !pending.has(done.urn)) return;
        const started = pending.get(done.urn);
        pending.delete(done.urn);
        const { type, name } = describeUrn(done.urn, done.type);
        record(`${stem}.resource.${type}.${name}`, now() - started);
      });
    },
  };
}
