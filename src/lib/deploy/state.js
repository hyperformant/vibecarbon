/**
 * Task-Level Deployment State Tracker
 * Manages persistence and hashing of deployment steps to enable granular resume.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Schema version for the persisted deploy-state file. Bump this whenever the
// on-disk shape or the meaning of a step's inputs/result changes. `load()`
// treats any file whose `version` doesn't match as fully-unstarted, so a CLI
// upgrade can't resume a deploy on top of an incompatible state shape (which
// would skip steps whose semantics have since changed).
//
// v2: introduced the `version` field itself + the dedicated-Pulumi-state
// bucket. Pre-v2 files (no `version`) are auto-invalidated — their `s3-setup`
// step predates the state bucket, so re-running it (to create + migrate the
// state bucket) is exactly what we want.
export const STATE_VERSION = 2;

export class StateTracker {
  constructor(projectName, environment) {
    this.projectName = projectName;
    this.environment = environment;
    this.stateDir = join(process.cwd(), '.vibecarbon');
    this.stateFile = join(this.stateDir, `deploy-state-${environment}.json`);
    this.state = this.load();
  }

  /**
   * Load state from disk. Auto-invalidates (returns a fresh, empty state) when
   * the persisted `version` doesn't match STATE_VERSION, so an upgraded CLI
   * never resumes on an incompatible state shape.
   */
  load() {
    if (existsSync(this.stateFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.stateFile, 'utf-8'));
        if (!parsed || parsed.version !== STATE_VERSION) {
          // Version mismatch (or a pre-versioning file) — discard so every
          // step is treated as not-completed and re-runs against reality.
          return { version: STATE_VERSION, steps: {} };
        }
        return parsed;
      } catch {
        return { version: STATE_VERSION, steps: {} };
      }
    }
    return { version: STATE_VERSION, steps: {} };
  }

  /**
   * Save state to disk
   */
  save() {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
    // Always stamp the current schema version so a later load() can detect
    // incompatibility after a CLI upgrade.
    this.state.version = STATE_VERSION;
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  /**
   * Calculate a hash for a step's inputs
   * @param {object} inputs
   * @returns {string}
   */
  calculateHash(inputs) {
    const data = JSON.stringify(inputs);
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * Check if a step should be skipped based on its input hash
   * @param {string} stepId
   * @param {object} inputs
   * @returns {boolean}
   */
  shouldSkip(stepId, inputs) {
    const currentHash = this.calculateHash(inputs);
    const stepState = this.state.steps[stepId];

    if (stepState && stepState.status === 'completed' && stepState.hash === currentHash) {
      return true;
    }
    return false;
  }

  /**
   * Like shouldSkip, but consults an optional async remote-existence probe
   * before agreeing to skip. Local hash equality only proves the step ran
   * with these inputs *once* — it says nothing about whether the remote
   * resource still exists (a bucket / server may have been deleted
   * out-of-band, e.g. by a prior `destroy`). If `verifyFn` resolves falsy,
   * the remote is gone and the step must re-run even on a hash match, so the
   * reconciling step runs instead of a downstream step failing on the missing
   * resource.
   *
   * `verifyFn` is only invoked when the hash already matches (the cheap local
   * check gates the network probe). A probe that THROWS is treated as
   * "can't confirm the remote is gone" → fall back to the hash decision
   * (skip), so a transient S3/API blip doesn't force an expensive re-run.
   *
   * @param {string} stepId
   * @param {object} inputs
   * @param {() => Promise<boolean>} [verifyFn] - resolves true if the remote
   *   resource still exists, false if it's gone.
   * @returns {Promise<boolean>}
   */
  async shouldSkipWithVerify(stepId, inputs, verifyFn) {
    if (!this.shouldSkip(stepId, inputs)) return false;
    if (typeof verifyFn !== 'function') return true;
    try {
      const stillExists = await verifyFn();
      return !!stillExists;
    } catch {
      // Probe failed — we can't prove the remote is gone. Honor the hash
      // decision (skip) rather than forcing a re-run on a transient error.
      return true;
    }
  }

  /**
   * Record a step as started
   * @param {string} stepId
   * @param {object} inputs
   */
  startStep(stepId, inputs) {
    const hash = this.calculateHash(inputs);
    this.state.steps[stepId] = {
      status: 'started',
      hash,
      startedAt: new Date().toISOString(),
    };
    this.save();
  }

  /**
   * Record a step as completed
   * @param {string} stepId
   * @param {object} result
   */
  completeStep(stepId, result = {}) {
    if (!this.state.steps[stepId]) {
      throw new Error(`Step ${stepId} was not started`);
    }
    this.state.steps[stepId].status = 'completed';
    this.state.steps[stepId].completedAt = new Date().toISOString();
    this.state.steps[stepId].result = result;
    this.save();
  }

  /**
   * Get the result of a completed step
   * @param {string} stepId
   * @returns {object|null}
   */
  getStepResult(stepId) {
    const stepState = this.state.steps[stepId];
    return stepState && stepState.status === 'completed' ? stepState.result : null;
  }

  /**
   * Clear state for a new deployment
   */
  clear() {
    this.state = { version: STATE_VERSION, steps: {} };
    if (existsSync(this.stateFile)) {
      try {
        writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
      } catch {}
    }
  }
}
