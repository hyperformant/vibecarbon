/**
 * The add-features step: `vibecarbon add <features>` when the scenario has
 * add-ons, then, on compose, the run's ACME CA in the project's `.env`.
 *
 * The CA line is written on every compose scenario, the stock one (no
 * add-ons, the e2e baseline) included. A compose server reads ACME_CA_SERVER
 * only from the `.env` the deploy bundle ships (src/lib/deploy/bundle.js),
 * never from the CLI's environment. This step used to return as soon as it
 * found no add-ons, before the CA line, so a stock compose scenario would
 * have issued its certificates from Let's Encrypt production while the CLI,
 * reading ACME_CA_SERVER from its own environment (setupE2EEnv), took the
 * deploy for staging. k8s reads the CA from the CLI's environment
 * (src/lib/deploy/k8s/k3s.js), so its `.env` needs no line.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatDotenvLine } from '../../../src/lib/dotenv.js';
import type { CliResult } from './types.js';

export interface AddFeaturesStepOptions {
  features: readonly string[];
  mode: string;
  projectDir: string;
  /** The run's CA, from resolveE2EAcmeCa(). */
  acme: { ca: string; directory: string };
  /** `vibecarbon add <features> -y` in the project (runAddFeatures). */
  add: (features: string[]) => Promise<CliResult>;
  log: (msg: string) => void;
}

export async function runAddFeaturesStep(opts: AddFeaturesStepOptions): Promise<void> {
  if (opts.features.length === 0) {
    opts.log('No add-ons to add: a stock deploy');
  } else {
    const result = await opts.add([...opts.features]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Add features exited with code ${result.exitCode}.\n` +
          `STDERR: ${(result.stderr || '').slice(-1000) || '(empty)'}\n` +
          `STDOUT tail: ${(result.stdout || '').slice(-2000) || '(empty)'}`,
      );
    }
  }

  // The CA the run chose (E2E_ACME_CA, default staging: much higher rate
  // limits than production). One helper picks it, no URL here.
  if (opts.mode.startsWith('compose')) {
    appendFileSync(
      join(opts.projectDir, '.env'),
      `\n# ACME CA for e2e tests (E2E_ACME_CA=${opts.acme.ca})\n` +
        `${formatDotenvLine('ACME_CA_SERVER', opts.acme.directory)}\n`,
    );
    opts.log(`Configured ACME ${opts.acme.ca} CA in .env`);
  }
}
