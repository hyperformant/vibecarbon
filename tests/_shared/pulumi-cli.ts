/**
 * Whether a `pulumi` binary answers on PATH. The real-engine iac tests run
 * only where it does (and must not skip under CI, which installs it). Asked
 * once per process: every caller gets the same answer.
 */
import { execFileSync } from 'node:child_process';

let onPath: boolean | undefined;

export function pulumiOnPath(): boolean {
  if (onPath === undefined) {
    try {
      execFileSync('pulumi', ['version'], { stdio: 'ignore' });
      onPath = true;
    } catch {
      onPath = false;
    }
  }
  return onPath;
}
