/**
 * The steps every provider guided setup runs the same way.
 *
 * Each `*-guided-setup.js` module keeps what is its own: the console guide,
 * the env var names, the order of its flow, and anything only that provider
 * needs (Vultr's cluster prompt, Scaleway's credential triple and domain
 * onboarding). This module holds the parts that were copied between them
 * word for word, so a fix lands in every provider at once:
 *
 *   - checkApiToken: the live token probe and how its status codes are read
 *   - verifiedEnvToken: the env-first lookup of an API token
 *   - promptForVerifiedToken: the paste, verify, retry loop
 *   - promptS3KeyPair: the access key and secret key prompts
 *   - createCredentialSaver: the "Save keys for future deploys?" question
 *   - finishS3Credentials: save the pair now, or hand the save to the caller
 *
 * A token description (`spec` below) is plain data plus the module's own
 * verifier:
 *   envKey    env var the token lives in, e.g. 'LINODE_API_TOKEN'
 *   provider  display name, e.g. 'Linode'
 *   noun      what the provider calls it: 'token' (default) or 'key'
 *   verify    async (token) => { valid, error?, unreachable? }
 *   format    optional { pattern, expected }: warn, never block, on a mismatch
 *   shapeProblem  optional (paste) => string|undefined, a hard shape check
 *             run before the token is accepted (Hetzner's 64 characters)
 */

import * as p from '@clack/prompts';
import { exitCancelled } from './cli/exit-guard.js';
import { spinner } from './cli/progress.js';
import { assertInteractiveStdin } from './cli/tty-guard.js';
import { c } from './colors.js';
import { registryEntry } from './config-registry.js';
import {
  dotenvPromptProblem,
  normalizeOperatorValue,
  pastedKeyShapeProblem,
  readOperatorVar,
} from './operator-env.js';
import { describeCredentialSource, setEnvVar } from './project.js';

/**
 * Probe a provider API with a credential and read the answer.
 *
 * @param {string} url - a cheap authenticated GET
 * @param {Record<string, string>} headers - carries the credential
 * @param {object} messages
 * @param {string} messages.api - provider name for the status fallthrough
 * @param {string} messages.unauthorized - what a 401 means on this provider
 * @param {string} [messages.forbidden] - what a 403 means, for a provider
 *   where it has a known cause; without it a 403 reads as any other status
 * @returns {Promise<{ valid: boolean, error?: string, unreachable?: boolean }>}
 */
export async function checkApiToken(url, headers, { api, unauthorized, forbidden }) {
  try {
    const res = await fetch(url, { headers });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: unauthorized };
    if (res.status === 403 && forbidden) return { valid: false, error: forbidden };
    // A 5xx is the PROVIDER's outage, not the operator's credential: treat it
    // like the network-error catch below (proceed with the env token; real
    // API calls fail honestly later if the outage persists). Live RCA
    // 2026-09-01 (run 33557406486): a Vultr API 502 on this preflight read
    // as "token invalid", and the non-TTY destroy died trying to prompt.
    if (res.status >= 500) return { valid: true, unreachable: true };
    return { valid: false, error: `${api} API returned status ${res.status}` };
  } catch {
    return { valid: true, unreachable: true };
  }
}

function warnIfBadTokenFormat(token, { provider, noun = 'token', format }) {
  if (format && !format.pattern.test(token)) {
    p.log.warn(
      `${provider} API ${noun} does not match the expected format (${format.expected}), proceeding anyway.`,
    );
  }
}

/**
 * The env-first half of getApiToken: the token from the shell or the
 * project's .env.local (folded in by bootstrapOperatorEnv), verified live.
 *
 * @param {object} spec - see the module doc
 * @returns {Promise<string|null>} the token, or null when it is unset or the
 *   provider rejected it (the caller then falls through to the prompt)
 */
export async function verifiedEnvToken(spec) {
  const { envKey, provider, noun = 'token', verify } = spec;
  const envToken = readOperatorVar(envKey).value;
  if (!envToken) return null;

  warnIfBadTokenFormat(envToken, spec);
  const check = await verify(envToken);
  if (!check.valid) {
    p.log.warn(
      `${envKey} from ${describeCredentialSource([envKey]).where} is set but invalid: ${check.error}`,
    );
    return null;
  }
  if (check.unreachable) {
    p.log.warn(`Could not reach ${provider} API to verify ${noun}, proceeding with saved ${noun}`);
  }
  p.log.info(`✓ Using ${provider} API ${noun} from ${describeCredentialSource([envKey]).label}`);
  return envToken;
}

/**
 * The interactive half of getApiToken: ask for the token, verify it against
 * the live API, and ask again until one passes.
 *
 * The caller guards and shows its guide first. This guards again because the
 * invariant is "any function that prompts, guards first": off a TTY clack's
 * promise never settles, and the process would drain into a silent exit 0
 * (the 2026-08-11 v1 RCA).
 *
 * @param {object} spec - see the module doc
 * @returns {Promise<string>} the normalized, verified token
 */
export async function promptForVerifiedToken(spec) {
  const { envKey, provider, noun = 'token', verify, shapeProblem } = spec;
  assertInteractiveStdin({ what: `the ${provider} API ${noun}`, envVar: envKey });
  const Noun = noun[0].toUpperCase() + noun.slice(1);

  let token;
  while (true) {
    token = await p.password({
      message: `Paste your ${provider} API ${noun} here`,
      validate: (v) => {
        if (!v || v.length < 10) return `API ${noun} is required`;
        return shapeProblem?.(v) ?? dotenvPromptProblem(envKey, v);
      },
    });

    if (p.isCancel(token)) {
      exitCancelled();
    }
    // First-time-user path (M11): the paste goes through the same
    // normalization every later readOperatorVar() read applies (trailing
    // newline, surrounding quotes, a stray "Bearer ") BEFORE it is verified
    // against the live API, exported to process.env or saved to .env.local.
    token = normalizeOperatorValue(token, registryEntry(envKey)).value;

    warnIfBadTokenFormat(token, spec);

    const s = spinner();
    s.start(`Verifying API ${noun}...`);
    const check = await verify(token);
    if (check.valid) {
      if (check.unreachable) {
        s.stop(`Could not reach ${provider} API, proceeding with unverified ${noun}`);
      } else {
        s.stop(`API ${noun} verified`);
      }
      break;
    }
    s.stop(`${Noun} invalid: ${check.error}`);
    p.log.warn(`Please try again with a valid ${noun}.`);
  }
  return token;
}

/**
 * Ask for an object-storage access key and secret key, normalized like every
 * later readOperatorVar() read (M11). Guards for the same reason as
 * promptForVerifiedToken; the caller guards and shows its guide first.
 *
 * @param {object} pair
 * @param {string} pair.provider - display name, e.g. 'Linode'
 * @param {string} pair.accessEnvKey - e.g. 'LINODE_ACCESS_KEY'
 * @param {string} pair.secretEnvKey - e.g. 'LINODE_SECRET_KEY'
 * @param {string} pair.label - what the provider calls the pair: 'S3',
 *   'Spaces' or 'Object Storage'
 * @returns {Promise<{accessKey: string, secretKey: string}>}
 */
export async function promptS3KeyPair({ provider, accessEnvKey, secretEnvKey, label }) {
  assertInteractiveStdin({
    what: `the ${provider} object-storage keys`,
    envVar: `${accessEnvKey}/${secretEnvKey}`,
  });

  const accessKeyInput = await p.text({
    message: `Paste your ${label} Access Key here`,
    validate: (v) => {
      if (!v || v.length < 10) return 'Access Key is required';
      return pastedKeyShapeProblem(accessEnvKey, v) ?? dotenvPromptProblem(accessEnvKey, v);
    },
  });

  if (p.isCancel(accessKeyInput)) {
    exitCancelled();
  }

  const secretKeyInput = await p.password({
    message: `Paste your ${label} Secret Key here`,
    validate: (v) => {
      if (!v || v.length < 10) return 'Secret Key is required';
      return pastedKeyShapeProblem(secretEnvKey, v) ?? dotenvPromptProblem(secretEnvKey, v);
    },
  });

  if (p.isCancel(secretKeyInput)) {
    exitCancelled();
  }

  return {
    accessKey: normalizeOperatorValue(accessKeyInput, registryEntry(accessEnvKey)).value,
    secretKey: normalizeOperatorValue(secretKeyInput, registryEntry(secretEnvKey)).value,
  };
}

/**
 * Build a module's saveIfWanted: ask once whether to save credentials, then
 * reuse the answer for every credential that module prompts for in this
 * process. Each guided-setup module creates its own, so the answer given for
 * one provider is not carried over to another.
 *
 * @param {object} owner
 * @param {string} owner.provider - display name, e.g. 'Hetzner'
 * @param {string} owner.envVar - the env var to name if the question is
 *   reached off a TTY
 * @returns {(envVars: Record<string, string>) => Promise<void>} takes a flat
 *   env-var-name to value map and writes it to the project's .env.local
 *   (operator-secret keys, see config-registry.js, always write localOnly,
 *   never .env)
 */
export function createCredentialSaver({ provider, envVar }) {
  // null = not asked yet, true/false = the operator's answer.
  let savePreference = null;

  return async function saveIfWanted(envVars) {
    if (savePreference === null) {
      // Unreachable by construction today (this only runs after an
      // interactive prompt already succeeded, so stdin was a TTY), but the
      // invariant is 'any function that prompts, guards first', so a future
      // caller that reaches it non-interactively fails loudly, not silently.
      assertInteractiveStdin({
        what: `whether to save the ${provider} credentials`,
        envVar,
      });
      const shouldSave = await p.confirm({
        message: 'Save keys for future deploys?',
        initialValue: true,
      });
      savePreference = shouldSave && !p.isCancel(shouldSave);
    }

    if (savePreference) {
      for (const [key, value] of Object.entries(envVars)) {
        setEnvVar(key, value, process.cwd(), { localOnly: true });
      }
      p.log.info(c.dim('Saved to .env.local'));
    }
  };
}

/**
 * The end of getS3Credentials for freshly pasted keys.
 *
 * deferSave: the caller verifies the keys against S3 first and calls save()
 * only once they pass, so a rejected pair is never written.
 *
 * @param {object} creds - what getS3Credentials returns
 * @param {Record<string, string>} keys - env-var-name to value map to save
 * @param {{ save: boolean, deferSave: boolean }} options
 * @param {(envVars: Record<string, string>) => Promise<void>} saveIfWanted
 * @returns {Promise<object>} creds, with a save() when deferSave is set
 */
export async function finishS3Credentials(creds, keys, { save, deferSave }, saveIfWanted) {
  if (deferSave) {
    return { ...creds, save: save ? () => saveIfWanted(keys) : async () => {} };
  }
  if (save) {
    await saveIfWanted(keys);
  }
  return creds;
}
