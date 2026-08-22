/**
 * Command Tracker — step-level timing and persistent log files for CLI commands
 *
 * Usage:
 *   const tracker = createTracker('deploy', { environment: 'prod' });
 *   const s = tracker.spinner();
 *   s.start('Provisioning cluster');
 *   s.stop('Cluster provisioned');
 *   const { formatted } = tracker.finish();
 */

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { spinner } from './cli/progress.js';

/**
 * Format milliseconds into a human-readable duration string.
 * @param {number} ms
 * @returns {string} e.g. "3s", "2m 14s"
 */
function formatDuration(ms) {
  const totalSecs = Math.round(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

/**
 * Format a timestamp for log lines (HH:MM:SS)
 * @param {Date} date
 * @returns {string}
 */
function formatTime(date) {
  return date.toISOString().slice(11, 19);
}

/**
 * Right-pad a duration string to a fixed width for aligned output.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function padDuration(str, width = 8) {
  return str.padStart(width);
}

/**
 * Create a CommandTracker for a CLI command.
 *
 * @param {string} command  - Command name (e.g. 'deploy', 'destroy')
 * @param {object} [meta]  - Key/value metadata written to the log header
 * @returns {CommandTracker}
 */
export function createTracker(command, meta = {}) {
  return new CommandTracker(command, meta);
}

/**
 * Create a prefixed tracker for parallel operations (e.g., HA deploys).
 * Instead of real @clack spinners (which corrupt when two run concurrently),
 * this uses p.log.info with a region/label prefix for each step.
 *
 * Duck-type compatible with CommandTracker — can be passed as options.tracker.
 *
 * @param {string} label - Prefix label (e.g., "fsn1", "nbg1")
 * @param {object} [opts] - Options
 * @param {CommandTracker} [opts.parent] - Parent tracker for log file writes
 * @returns {object} Tracker-compatible object
 */
export function createPrefixedTracker(label, opts = {}) {
  const parent = opts.parent;
  const dim = (s) => `\x1b[2m${s}\x1b[22m`;
  const prefix = dim(`[${label}]`);

  return {
    spinner() {
      let stepStart = null;
      let stepLabel = null;

      return {
        start(msg) {
          stepStart = performance.now();
          stepLabel = msg;
          p.log.step(`${prefix} ${msg}`);
          parent?.log?.(`[${label}] START  ${msg}`);
        },
        stop(msg) {
          const elapsed = stepStart ? formatDuration(performance.now() - stepStart) : '';
          const display = msg || stepLabel;
          p.log.info(`${prefix} ${display} ${dim(`(${elapsed})`)}`);
          parent?.log?.(`[${label}] DONE   ${display} (${elapsed})`);
          stepStart = null;
          stepLabel = null;
        },
        message(msg) {
          p.log.info(`${prefix} ${msg}`);
          parent?.log?.(`[${label}] UPDATE ${msg}`);
        },
      };
    },
    log(msg) {
      parent?.log?.(`[${label}] ${msg}`);
    },
  };
}

class CommandTracker {
  constructor(command, meta) {
    this.command = command;
    this.meta = meta;
    this.startTime = performance.now();
    this.steps = []; // { label, durationMs }
    this._currentStep = null; // { label, startTime }
    this._stream = null;

    // Open log file
    const logsDir = join(process.cwd(), '.vibecarbon', 'logs');
    try {
      if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const envSuffix = meta.environment ? `-${meta.environment}` : '';
      const filename = `${command}${envSuffix}-${timestamp}.log`;
      this.logPath = join(logsDir, filename);
      this._stream = createWriteStream(this.logPath, { flags: 'a' });

      // Write header
      this._write(`=== vibecarbon ${command} ===`);
      this._write(`Started: ${new Date().toISOString()}`);
      for (const [key, value] of Object.entries(meta)) {
        if (value != null) {
          this._write(`  ${key}: ${value}`);
        }
      }
      this._write('');
    } catch {
      // If we can't create the log file (e.g. no .vibecarbon dir), continue without logging
      this.logPath = null;
    }
  }

  /**
   * Create a spinner wrapper that records timing and writes to the log.
   * Duck-type compatible with p.spinner().
   * @returns {{ start(msg: string): void, stop(msg: string, code?: number): void, message(msg: string): void }}
   */
  spinner() {
    let realSpinner = spinner();
    const tracker = this;

    return {
      start(msg) {
        // If a previous step wasn't stopped, record it as-is
        if (tracker._currentStep) {
          const elapsed = performance.now() - tracker._currentStep.startTime;
          tracker.steps.push({ label: tracker._currentStep.label, durationMs: elapsed });
        }

        tracker._currentStep = { label: msg, startTime: performance.now() };
        tracker._write(`[${formatTime(new Date())}] START  ${msg}`);
        // Create a fresh spinner — clack spinners don't cleanly restart after stop()
        realSpinner = spinner();
        realSpinner.start(msg);
      },

      stop(msg, code) {
        if (tracker._currentStep) {
          const elapsed = performance.now() - tracker._currentStep.startTime;
          tracker.steps.push({ label: msg || tracker._currentStep.label, durationMs: elapsed });
          tracker._write(
            `[${formatTime(new Date())}] DONE   ${msg || tracker._currentStep.label} (${formatDuration(elapsed)})`,
          );
          tracker._currentStep = null;
        }
        realSpinner.stop(msg, code);
      },

      message(msg) {
        tracker._write(`[${formatTime(new Date())}] UPDATE ${msg}`);
        realSpinner.message(msg);
      },
    };
  }

  /**
   * Write an arbitrary line to the log file.
   * @param {string} msg
   */
  log(msg) {
    this._write(`[${formatTime(new Date())}] LOG    ${msg}`);
  }

  /**
   * Finalize tracking: write summary to log, print timing table to console.
   * @returns {{ elapsed: number, formatted: string, logPath: string | null }}
   */
  finish() {
    const totalMs = performance.now() - this.startTime;
    const formatted = formatDuration(totalMs);

    // Write step summary to log
    if (this.steps.length > 0) {
      this._write('');
      this._write('=== Step Summary ===');
      for (const step of this.steps) {
        this._write(`  ${padDuration(formatDuration(step.durationMs))}  ${step.label}`);
      }
      this._write(`  ${padDuration(formatted)}  TOTAL`);
    }
    this._write('');
    this._write(`Finished: ${new Date().toISOString()}`);

    // Close stream
    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }

    // Print timing stats table to console (only if >1 step)
    if (this.steps.length > 1) {
      const lines = this.steps.map(
        (step) => `${padDuration(formatDuration(step.durationMs))}  ${step.label}`,
      );
      lines.push(`${padDuration(formatted)}  Total`);
      p.note(lines.join('\n'), 'Stats');
    }

    return { elapsed: totalMs, formatted, logPath: this.logPath };
  }

  /**
   * Write a line to the log file stream.
   * @param {string} line
   * @private
   */
  _write(line) {
    if (this._stream) {
      this._stream.write(`${line}\n`);
    }
  }
}
