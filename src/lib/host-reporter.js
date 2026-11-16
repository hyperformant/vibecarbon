/**
 * The host reporter as the CLI ships it: one POSIX sh snippet on disk
 * (carbon/cloud-init/k3s/_host-reporter.sh) that installs the reporter script
 * and its systemd units. The snippet is the single source; the reporter body
 * is cut out of its heredoc, never copied here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLOUD_INIT_DIR } from './iac/cloud-init.js';

export const HOST_REPORTER_SNIPPET = join(CLOUD_INIT_DIR, '_host-reporter.sh');

const REPORTER_START = "<<'VC_HOST_REPORTER_EOF'\n";
const REPORTER_END = '\nVC_HOST_REPORTER_EOF\n';

let installer;
let script;

/**
 * The installer: writes the reporter and units, enables and starts them.
 *
 * @returns {string}
 */
export function hostReporterInstaller() {
  installer ??= readFileSync(HOST_REPORTER_SNIPPET, 'utf-8');
  return installer;
}

/**
 * The reporter script the installer writes: the heredoc body.
 *
 * @returns {string}
 */
export function hostReporterScript() {
  if (script === undefined) {
    const text = hostReporterInstaller();
    const open = text.indexOf(REPORTER_START);
    const close = open === -1 ? -1 : text.indexOf(REPORTER_END, open + REPORTER_START.length);
    if (open === -1 || close === -1) {
      throw new Error(`${HOST_REPORTER_SNIPPET}: the reporter heredoc markers are missing`);
    }
    script = `${text.slice(open + REPORTER_START.length, close)}\n`;
  }
  return script;
}

/**
 * A remote script that installs the reporter first. The installer runs in a
 * subshell whose failure cannot stop the script.
 *
 * @param {string} body
 * @returns {string}
 */
export function withHostReporter(body) {
  return `(\n${hostReporterInstaller()}) >/dev/null 2>&1 || true\n${body}`;
}
