/**
 * Scaleway Guided Setup - Interactive prompts for first-time setup
 *
 * Mirrors vultr-guided-setup.js / digitalocean-guided-setup.js /
 * linode-guided-setup.js structure (see their docs for the shared design):
 * lookup chain env var (shell or the project's .env.local, folded in by
 * bootstrapOperatorEnv at CLI startup — see project.js) → interactive
 * prompt, single "Save keys for future deploys?" prompt shared across every
 * credential prompted within one guided-setup flow.
 *
 * THE CREDENTIAL IS A TRIPLE (the structural difference from every sibling
 * module): Scaleway's tooling requires SCALEWAY_ACCESS_KEY + SCALEWAY_SECRET_KEY +
 * SCALEWAY_DEFAULT_PROJECT_ID together (the Pulumi provider marks all three
 * required; the REST path uses the secret key alone as X-Auth-Token), so
 * getApiToken collects and persists all three in one flow — its RETURN
 * value stays the secret key (TOKEN_ENV), preserving the cross-provider
 * token contract. S3 needs NO separate keys: the same IAM pair signs
 * Object Storage (audit-verified), so getS3Credentials maps the pair
 * straight from the compute credential.
 *
 * THE DEDICATED-PROJECT DOCTRINE (the biggest Scaleway gotcha, from the
 * step-0 audit): Scaleway SSH keys are PROJECT-scoped and
 * `scw-fetch-ssh-keys` rewrites every instance's authorized_keys from ALL
 * Project keys at every boot — so vibecarbon's deploy key would open every
 * other instance in a shared Project, and destroy would revoke access to
 * unrelated servers. vibecarbon therefore requires a DEDICATED Scaleway
 * Project per vibecarbon project, and the API key's "preferred Project for
 * Object Storage" (chosen at key creation) must be that SAME Project or
 * buckets land where the sweep and console won't look.
 *
 * THE GUIDE MIRRORS THE REAL CONSOLE FLOW (corrected 2026-08-09 from an
 * operator walkthrough of the actual key-creation dialog, cross-checked
 * against iam/how-to/create-api-keys.mdx + create-application.mdx +
 * create-policy.mdx):
 *   1. Project first (everything below happens with it selected);
 *   2. an IAM APPLICATION as the key's bearer, WITH A POLICY ATTACHED —
 *      doc-verbatim: "until you attach a policy to the application, it
 *      will have no permissions in your Organization", so a fresh
 *      application key 403s every call until the policy exists;
 *   3. ONE Generate-API-key dialog carrying bearer / description /
 *      EXPIRATION (org-enforceable ceiling — 1 year max on the walked
 *      org; a Scaleway key silently expires and then every deploy/
 *      failover/destroy 401s, unlike any sibling provider's token) / the
 *      Object Storage preferred-Project question;
 *   4. the dialog's second screen reveals the access key + secret key
 *      (secret shown ONCE).
 *
 * IT ALSO OWNS DOMAIN ONBOARDING (`onboardDomain`), which no sibling
 * guided-setup module has, because no sibling cloud needs it: on
 * Hetzner/DO/Linode/Vultr "manage this domain's DNS" is a POST that always
 * succeeds. Scaleway refuses every zone and record call for a domain the
 * account does not own (403 "domain not found"), so a Scaleway operator whose
 * domain sits at another registrar has to register it as an EXTERNAL domain
 * and prove ownership first. See scaleway-dns.js for the API half.
 *
 * Two things that flow does which are easy to get wrong, and which are the
 * reason it is a guided flow rather than a printf:
 *   - ORDER. Validate BEFORE moving nameservers. Delegating to Scaleway while
 *     the domain is still unvalidated deadlocks it permanently — the ownership
 *     TXT can no longer resolve, because the domain now points at the one host
 *     that refuses to serve it. The flow reads the LIVE delegation first and
 *     names that state when it finds it.
 *   - THE RECORD GOES SOMEWHERE ELSE. The ownership TXT belongs in whichever
 *     DNS the domain uses TODAY, which is frequently another backend we drive.
 *     When it is, the CLI publishes the record itself (registry lookup, no
 *     provider branch) instead of asking a human to go do it.
 *
 * See the scaleway-provider-step0-audit plan
 * (Operator UX section carries the same corrected flow).
 */

import * as p from '@clack/prompts';
import { exitCancelled } from './cli/exit-guard.js';
import { spinner } from './cli/progress.js';
import { assertInteractiveStdin } from './cli/tty-guard.js';
import { c } from './colors.js';
import { resolveNameservers } from './dns-propagation.js';
import { DNS_PROVIDERS, getDnsProvider, locateDomainBackend } from './dns-provider.js';
import { setEnvVar } from './project.js';
import {
  EXTERNAL_DOMAIN_CHALLENGE_NAME,
  getExternalDomainRegistration,
  NAMESERVERS,
  ONBOARDING_WINDOW_DAYS,
  registerExternalDomain,
  VALIDATION_WINDOW_HOURS,
  validationDeadline,
  waitForExternalDomainActive,
} from './scaleway-dns.js';

const API_BASE = 'https://api.scaleway.com';

// Companion env vars getApiToken collects alongside the token
// (SCALEWAY_SECRET_KEY). configure-providers.js reads this to persist and
// summarize the full triple generically.
export const EXTRA_ENV_KEYS = ['SCALEWAY_ACCESS_KEY', 'SCALEWAY_DEFAULT_PROJECT_ID'];

// Access key: 20 chars, self-prefixed (SDK validator ^SCW[A-Z0-9]{17}$ —
// validation/is.go). Secret key and Project ID are both plain UUIDs (same
// source). Checked against every value we see — WARN, never block.
const ACCESS_KEY_FORMAT = /^SCW[A-Z0-9]{17}$/;
const UUID_FORMAT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function warnIfBadFormat(value, what, format, expected) {
  if (!format.test(value)) {
    p.log.warn(
      `Scaleway ${what} does not match the expected format (${expected}), proceeding anyway.`,
    );
  }
}

/**
 * Validate a Scaleway secret key by making a lightweight API call —
 * `GET /instance/v1/zones/fr-par-1/servers?per_page=1` with X-Auth-Token
 * (the secret key alone authenticates the REST path). 401 = bad key;
 * 403 = key valid but its IAM policy lacks Instance read (still names the
 * real problem).
 * @param {string} secretKey
 * @returns {Promise<{ valid: boolean, error?: string, unreachable?: boolean }>}
 */
async function validateScalewaySecretKey(secretKey) {
  try {
    const res = await fetch(`${API_BASE}/instance/v1/zones/fr-par-1/servers?per_page=1`, {
      headers: { 'X-Auth-Token': secretKey },
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) {
      return { valid: false, error: 'secret key is invalid or was revoked' };
    }
    if (res.status === 403) {
      return {
        valid: false,
        error:
          'access denied (403); the key authenticates but its BEARER has no usable IAM ' +
          'permissions. Most common cause: the key belongs to an IAM application with NO ' +
          'policy attached (applications have zero permissions by default). Attach a policy ' +
          '(console → IAM → Policies) with the application as principal and resource ' +
          'permission sets on the project; also note a just-attached policy can take a few ' +
          'minutes to apply',
      };
    }
    return { valid: false, error: `Scaleway API returned status ${res.status}` };
  } catch {
    return { valid: true, unreachable: true };
  }
}

/**
 * Display visual guide for API key creation, mirroring the REAL console
 * flow (operator walkthrough 2026-08-09 + iam/how-to docs — see the module
 * header). Four numbered steps rather than the B2a standard's three: the
 * real flow has four distinct stations (Project → application+policy → the
 * one key dialog → the credentials reveal), and every one of them carries
 * a create-time decision that cannot be patched later.
 */
export function displayApiTokenGuide(projectName) {
  const appName = projectName || 'vibecarbon';
  p.note(
    [
      `${c.bold('1.')} Create a ${c.boldCyan('DEDICATED Project')} FIRST ${c.dim('(console project switcher → create project)')} and keep it ${c.bold('selected')} for every step below.`,
      `${c.dim('   ├─')} Name it e.g. ${c.info(`"${appName}"`)}; copy its ${c.boldCyan('Project ID')} ${c.dim('(a UUID) from')} ${c.boldCyanUnderline('https://console.scaleway.com/project/settings')}`,
      `${c.dim('   └─')} ${c.boldYellow('⚠️  Why dedicated:')} ${c.dim('Scaleway SSH keys are Project-wide and re-applied to EVERY instance at each boot, sharing a Project shares root access.')}`,
      '',
      `${c.bold('2.')} Create an ${c.boldCyan('IAM application')} as the key's bearer, and ${c.boldYellow('ATTACH A POLICY to it')}:`,
      `${c.dim('   ├─')} ${c.boldCyanUnderline('https://console.scaleway.com/iam/applications')} ${c.dim('→ Create application, name it e.g.')} ${c.info(`"${appName}"`)} ${c.dim('(a non-human identity; the credential outlives people and rotates independently).')}`,
      `${c.dim('   ├─')} ${c.boldCyanUnderline('https://console.scaleway.com/iam/policies')} ${c.dim('→ Create policy: principal = the application; rule =')} ${c.info('AllProductsFullAccess')} ${c.dim('(or minimally Instances + BlockStorage + ObjectStorage + SSHKeys FullAccess), scope =')} ${c.bold('the dedicated Project')}${c.dim('.')}`,
      `${c.dim('   └─')} ${c.boldYellow('⚠️  Without a policy the application has ZERO permissions')} ${c.dim('; its key 401/403s every call. Object Storage permissions can take ~5 minutes to apply.')}`,
      '',
      `${c.bold('3.')} Generate the API key: ${c.boldCyanUnderline('https://console.scaleway.com/iam/api-keys')} ${c.dim(', one dialog, four decisions:')}`,
      `${c.dim('   ├─')} Bearer: ${c.boldCyan('An application')} ${c.dim('→ select')} ${c.info(`"${appName}"`)} ${c.dim('("Myself" works but ties the credential to a personal user).')}`,
      `${c.dim('   ├─')} ${c.boldYellow('⚠️  Expiration: pick the MAXIMUM offered (capped at 1 year)')} ${c.dim('and set a renewal reminder NOW; the key expires SILENTLY and every later deploy/failover/destroy 401s. No sibling provider token does this.')}`,
      `${c.dim('   └─')} "Used for Object Storage?" → ${c.boldCyan('Yes, set up preferred Project')} ${c.dim('→ the')} ${c.bold('same dedicated Project')} ${c.dim('— "skip" silently binds whichever Project the console had selected.')}`,
      '',
      `${c.bold('4.')} The next screen reveals the ${c.boldCyan('access key')} ${c.dim('(SCW…)')} and the ${c.boldCyan('secret key')} ${c.dim('(a UUID, ')} ${c.boldYellow('shown ONCE')}${c.dim(', copy it immediately). Paste both + the Project ID below.')}`,
      `${c.dim('   └─')} ${c.dim('Also validate your identity (not just payment) at')} ${c.boldCyanUnderline('https://console.scaleway.com/organization/settings')} ${c.dim(', instance quotas roughly double and several types are gated on it.')}`,
    ].join('\n'),
    c.boldCyan('🔑 Scaleway API Key Setup'),
  );
}

/**
 * Display guide for Object Storage credentials. On Scaleway there is
 * nothing new to create — the SAME IAM key pair signs S3 — so this guide
 * only explains that and re-states the preferred-Project decision, which
 * lives INSIDE the Generate-API-key dialog ("Will this API key be used for
 * Object Storage?"), not on a separate storage page.
 */
export function displayS3CredentialsGuide(_projectName) {
  p.note(
    [
      `${c.bold('1.')} Nothing extra to create: your ${c.boldCyan('SCALEWAY_ACCESS_KEY')} / ${c.boldCyan('SCALEWAY_SECRET_KEY')} pair also signs Object Storage.`,
      '',
      `${c.bold('2.')} ${c.boldYellow('⚠️  Check the key’s preferred Project:')} S3 has no Project parameter, so every key carries a ${c.boldCyan('preferred Project for Object Storage')} — chosen INSIDE the Generate-API-key dialog ("Will this API key be used for Object Storage?").`,
      `${c.dim('   ├─')} ${c.dim('It must be the SAME dedicated Project your servers deploy into, or buckets land where neither the console nor the sweep will look.')}`,
      `${c.dim('   └─')} ${c.dim('Answering "skip" binds whichever Project the console had selected — if in doubt, regenerate the key at')} ${c.boldCyanUnderline('https://console.scaleway.com/iam/api-keys')} ${c.dim('(the preference is fixed at creation).')}`,
      '',
      c.dim('Why Object Storage? Required for database backups and file uploads.'),
    ].join('\n'),
    c.boldCyan('🗄️  Scaleway Object Storage Setup'),
  );
}

// Session-level save preference — same contract as the identical
// module-level flag in the sibling guided-setup modules.
let _savePreference = null;

/**
 * Ask the user once whether to save credentials, then reuse the answer.
 * @param {Record<string, string>} envVars
 */
async function saveIfWanted(envVars) {
  if (_savePreference === null) {
    // In practice unreachable off a TTY (an interactive prompt already
    // succeeded to get here), but the invariant is 'any function that prompts,
    // guards first' — so a future caller reaching it non-interactively fails
    // loudly instead of silently.
    assertInteractiveStdin({
      what: 'whether to save the Scaleway credentials',
      envVar: 'SCALEWAY_SECRET_KEY',
    });
    const shouldSave = await p.confirm({
      message: 'Save keys for future deploys?',
      initialValue: true,
    });
    _savePreference = shouldSave && !p.isCancel(shouldSave);
  }

  if (_savePreference) {
    for (const [key, value] of Object.entries(envVars)) {
      setEnvVar(key, value, process.cwd(), { localOnly: true });
    }
    p.log.info(c.dim('Saved to .env.local'));
  }
}

/**
 * Cancel-aware prompt helper: exits the process on Ctrl-C.
 *
 * Ctrl-C must NOT exit 0. A cancelled setup leaves no credentials behind, so
 * a zero status tells any caller — a script, CI, an agent — that provisioning
 * succeeded when nothing happened. exitCancelled routes it to 130, the
 * conventional SIGINT status, and keeps it distinct from exitDeclined's 1
 * (the user answered "no" on purpose).
 */
async function promptOrExit(promise) {
  const value = await promise;
  if (p.isCancel(value)) {
    exitCancelled('Operation cancelled.');
  }
  return value;
}

/**
 * Prompt for the two non-secret companions (access key + project id).
 * @returns {Promise<{accessKey: string, projectId: string}>}
 */
async function promptCompanions() {
  const accessKey = await promptOrExit(
    p.text({
      message: 'Paste your Scaleway Access Key here (starts with SCW)',
      validate: (v) => {
        if (!v || v.length < 10) return 'Access key is required';
        return undefined;
      },
    }),
  );
  warnIfBadFormat(accessKey, 'access key', ACCESS_KEY_FORMAT, 'SCW + 17 uppercase alphanumerics');

  const projectId = await promptOrExit(
    p.text({
      message: 'Paste your dedicated Project ID here (UUID, console → Project settings)',
      validate: (v) => {
        if (!v || v.length < 10) return 'Project ID is required';
        return undefined;
      },
    }),
  );
  warnIfBadFormat(projectId, 'Project ID', UUID_FORMAT, 'a UUID');

  return { accessKey, projectId };
}

/**
 * Get the Scaleway credential TRIPLE with improved visual guidance,
 * returning the SECRET KEY (the TOKEN_ENV value — cross-provider token
 * contract). Lookup order: env vars (shell, or the project's .env.local
 * via bootstrapOperatorEnv) → interactive prompt. The env fast-path only
 * short-circuits when ALL THREE are present — a partial triple would
 * otherwise fail at deploy start (buildIacEnv's throw), which is exactly
 * what this flow exists to prevent.
 *
 * @param {string} [projectName] - Project name for display in guide
 * @param {{ save?: boolean, force?: boolean }} [options]
 * @returns {Promise<string|null>} the secret key
 */
export async function getApiToken(projectName, options = {}) {
  const { save = true, force = false } = options;

  if (!force) {
    const envSecret = process.env.SCALEWAY_SECRET_KEY;
    const envAccess = process.env.SCALEWAY_ACCESS_KEY;
    const envProject = process.env.SCALEWAY_DEFAULT_PROJECT_ID;
    if (envSecret && envAccess && envProject) {
      warnIfBadFormat(envSecret, 'secret key', UUID_FORMAT, 'a UUID');
      const check = await validateScalewaySecretKey(envSecret);
      if (!check.valid) {
        p.log.warn(`SCALEWAY_SECRET_KEY environment variable is set but invalid: ${check.error}`);
        // Fall through to interactive prompt
      } else {
        if (check.unreachable) {
          p.log.warn('Could not reach Scaleway API to verify key, proceeding with saved key');
        }
        p.log.info('✓ Using Scaleway credentials from SCALEWAY_* environment variables');
        return envSecret;
      }
    } else if (envSecret) {
      const missing = [
        !envAccess && 'SCALEWAY_ACCESS_KEY',
        !envProject && 'SCALEWAY_DEFAULT_PROJECT_ID',
      ].filter(Boolean);
      p.log.warn(
        `SCALEWAY_SECRET_KEY is set but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not — Scaleway needs the full triple; collecting it now.`,
      );
    }
  }

  // Off a TTY this prompt can never be answered — clack's promise would
  // neither resolve nor cancel, draining the event loop into a silent
  // exit 0 (the 2026-08-11 v1 RCA). Fail loudly with the env var instead.
  assertInteractiveStdin({ what: 'the Scaleway Secret Key', envVar: 'SCALEWAY_SECRET_KEY' });

  // Interactive prompt (with retry on invalid secret key)
  displayApiTokenGuide(projectName);

  let secretKey;
  while (true) {
    secretKey = await promptOrExit(
      p.password({
        message: 'Paste your Scaleway Secret Key here',
        validate: (v) => {
          if (!v || v.length < 10) return 'Secret key is required';
          return undefined;
        },
      }),
    );

    warnIfBadFormat(secretKey, 'secret key', UUID_FORMAT, 'a UUID');

    const s = spinner();
    s.start('Verifying secret key...');
    const check = await validateScalewaySecretKey(secretKey);
    if (check.valid) {
      if (check.unreachable) {
        s.stop('Could not reach Scaleway API, proceeding with unverified key');
      } else {
        s.stop('Secret key verified');
      }
      break;
    }
    s.stop(`Key invalid: ${check.error}`);
    p.log.warn('Please try again with a valid key.');
  }

  const { accessKey, projectId } = await promptCompanions();

  // In-process coherence (A2): freshly-entered credentials must be visible
  // to any later env-first resolution (buildIacEnv, S3 mapping) in this
  // same process, regardless of whether the operator persists them below.
  process.env.SCALEWAY_SECRET_KEY = secretKey;
  process.env.SCALEWAY_ACCESS_KEY = accessKey;
  process.env.SCALEWAY_DEFAULT_PROJECT_ID = projectId;

  if (save) {
    await saveIfWanted({
      SCALEWAY_SECRET_KEY: secretKey,
      SCALEWAY_ACCESS_KEY: accessKey,
      SCALEWAY_DEFAULT_PROJECT_ID: projectId,
    });
  }

  return secretKey;
}

/**
 * Best guess at the REGISTRABLE domain (eTLD+1) behind an FQDN: the last two
 * labels. Deliberately a SUGGESTION the operator confirms rather than a
 * decision — getting this right in general needs the Public Suffix List
 * (`app.example.co.uk` → `example.co.uk`, not `co.uk`), and registering the
 * wrong name is a 14-day account-level commitment, not a retryable API call.
 *
 * @param {string|null|undefined} domain
 * @returns {string} the suggestion, possibly empty
 */
function likelyRegistrableDomain(domain) {
  const labels = String(domain ?? '')
    .trim()
    .replace(/\.$/, '')
    .toLowerCase()
    .split('.')
    .filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(-2).join('.');
}

/**
 * True when a domain's live delegation already points at Scaleway.
 * @param {string[]|null} nameservers - as resolveNameservers returns them
 * @returns {boolean}
 */
function delegatedToScaleway(nameservers) {
  return (nameservers ?? []).some((ns) => ns.endsWith('dom.scw.cloud'));
}

/**
 * The 48h window as an ABSOLUTE moment. "48 hours" is useless to an operator
 * who comes back tomorrow and needs to know whether they still have time.
 * @param {Date|null} deadline
 * @returns {string|null}
 */
function formatDeadline(deadline) {
  if (!deadline) return null;
  const stamp = `${deadline.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const hoursLeft = Math.round((deadline.getTime() - Date.now()) / 3_600_000);
  if (hoursLeft <= 0) return `${stamp} (EXPIRED; the registration may already be gone)`;
  return `${stamp} (~${hoursLeft}h from now)`;
}

/**
 * Step one: publish the ownership TXT at the domain's CURRENT DNS host.
 *
 * `published` flips this from an instruction into a receipt — when the CLI
 * wrote the record itself there is nothing for the operator to do but wait, and
 * telling them to add a record they already have invites a duplicate.
 *
 * @param {string} domain
 * @param {object} state
 * @param {string|null} state.validationToken
 * @param {Date|null} state.deadline
 * @param {string|null} [state.publishedVia] - human label of the DNS backend
 *   that already carries the record, or null when nobody has published it
 */
export function displayExternalDomainInstructions(domain, state) {
  const { validationToken, deadline, publishedVia = null } = state;
  const expiry = formatDeadline(deadline);

  p.note(
    [
      publishedVia
        ? `${c.bold('1.')} ${c.boldCyan('Done for you:')} the ownership record is published in ${c.info(publishedVia)}.`
        : `${c.bold('1.')} At your ${c.boldCyan('current DNS host')} for ${c.info(domain)} ${c.bold('(not Scaleway)')}, add this ${c.boldCyan('TXT')} record:`,
      `${c.dim('   ├─')} Name:  ${c.boldCyan(EXTERNAL_DOMAIN_CHALLENGE_NAME)} ${c.dim(`(i.e. ${EXTERNAL_DOMAIN_CHALLENGE_NAME}.${domain})`)}`,
      `${c.dim('   ├─')} Value: ${validationToken ? c.boldCyan(validationToken) : c.boldYellow('(token not returned, read it from the console → Domains & DNS → External domains)')}`,
      expiry
        ? `${c.dim('   ├─')} ${c.boldYellow('⚠️  Must be live by:')} ${c.bold(expiry)}${c.dim(', after that Scaleway deletes the registration and you start over.')}`
        : `${c.dim('   ├─')} ${c.boldYellow(`⚠️  Must be live within ${VALIDATION_WINDOW_HOURS}h of registering`)} ${c.dim(', after that Scaleway deletes the registration and you start over.')}`,
      `${c.dim('   └─')} ${c.dim('Scaleway re-checks on its own schedule; several minutes is normal.')}`,
      '',
      `${c.bold('2.')} ${c.boldYellow('DO NOT change your nameservers yet.')} ${c.dim('Wait for the domain to go green first.')}`,
      `${c.dim('   └─')} ${c.dim('Moving them early deadlocks the domain: it would delegate to Scaleway, Scaleway will not serve it until it validates, and the TXT above could then never resolve.')}`,
      '',
      `${c.bold('3.')} ${c.dim('Once it is green, re-run this deploy; it will pick up where you left off and tell you which nameservers to set.')}`,
    ].join('\n'),
    c.boldCyan('🌐 Finish adding this domain to Scaleway DNS'),
  );
}

/**
 * Step two, shown only after the domain has actually validated. Kept separate
 * from step one on purpose: the whole failure mode this flow exists to prevent
 * is an operator doing these two things in the wrong order.
 *
 * @param {string} domain
 */
export function displayNameserverStep(domain) {
  p.note(
    [
      `${c.bold(`${domain} is validated.`)} ${c.dim('Now; and only now — repoint its')} ${c.boldCyan('nameservers')} ${c.dim('at your registrar:')}`,
      ...NAMESERVERS.map((ns) => `${c.dim('   ├─')} ${c.boldCyan(ns)}`),
      `${c.dim('   └─')} ${c.dim(`Whole-process deadline: ${ONBOARDING_WINDOW_DAYS} days from registration.`)}`,
      '',
      c.dim(
        `Once the new delegation propagates, re-run this deploy; the ${domain} zone will be discovered automatically. The ${EXTERNAL_DOMAIN_CHALLENGE_NAME} TXT is no longer needed and can be deleted.`,
      ),
    ].join('\n'),
    c.boldCyan('🌐 Last step: move the nameservers'),
  );
}

/**
 * The deadlock: nameservers already delegated to Scaleway while the domain is
 * still unvalidated. Nothing can fix this from our side — the ownership record
 * has to be resolvable, and the only host the world will now ask is the one
 * refusing to answer.
 *
 * @param {string} domain
 * @param {string[]|null} nameservers - the live delegation
 */
export function displayDelegationDeadlock(domain, nameservers) {
  p.log.error(
    `${domain} is stuck: its nameservers point at Scaleway, but it is not validated yet.`,
  );
  p.note(
    [
      `${c.dim('Current delegation:')} ${c.bold((nameservers ?? []).join(', ') || 'unknown')}`,
      '',
      c.dim(
        'Scaleway will not serve a zone for a domain that has not proved ownership, and ownership ' +
          `is proved by a ${EXTERNAL_DOMAIN_CHALLENGE_NAME} TXT record that the world can resolve. ` +
          'With the nameservers already moved, that record has nowhere to live: the domain now ' +
          'delegates to the one host that refuses to answer for it.',
      ),
      '',
      `${c.bold('To get unstuck:')}`,
      `${c.dim('   ├─')} 1. At your registrar, point the nameservers ${c.bold('back')} at your previous DNS host.`,
      `${c.dim('   ├─')} 2. Publish the ${c.boldCyan(EXTERNAL_DOMAIN_CHALLENGE_NAME)} TXT there and wait for Scaleway to go green.`,
      `${c.dim('   └─')} 3. ${c.bold('Then')} move the nameservers to Scaleway.`,
    ].join('\n'),
    c.boldYellow('⚠️  Nameservers moved too early'),
  );
}

/**
 * Onboard a domain Scaleway does not manage yet, so a Scaleway user whose
 * domain lives at another registrar is not stranded on manual DNS with no
 * explanation.
 *
 * Exported under the seam-generic name the deploy prompts sniff for
 * (`onboardDomain`): every other DNS backend can simply POST a new zone, so
 * only this one implements it, and the call site capability-sniffs rather than
 * branching on a provider id.
 *
 * THE ORDER IS THE WHOLE POINT. Register → publish the ownership TXT AT THE
 * CURRENT DNS HOST → wait for green → only then move the nameservers. Doing
 * the last step early deadlocks the domain permanently (see
 * displayDelegationDeadlock), so this flow checks the live delegation before
 * anything else and refuses to send an operator further down a path that
 * cannot work.
 *
 * The one automation worth having: the ownership TXT has to be published
 * wherever the domain's DNS lives TODAY, and that is very often a backend we
 * already drive. When `locateDomainBackend` finds one, the CLI offers to write
 * the record itself, turning a multi-day manual dance into a single confirm.
 * Otherwise the printed instructions carry the same information.
 *
 * `ready: true` means the domain is validated AND its nameservers already
 * point at Scaleway — i.e. records written through the API will actually
 * resolve. A domain that is merely validated is NOT ready: the deploy would
 * write records into a zone nobody is asking, and then fail ACME.
 *
 * @param {string} secretKey - Scaleway secret key
 * @param {string|null} [domain] - the deployment domain, used to seed the
 *   registrable-name suggestion
 * @param {object} [options]
 * @param {string} [options.projectId]
 * @param {number} [options.validationTimeoutMs] - budget for the post-publish
 *   poll; timing out is an ordinary outcome, not a failure
 * @returns {Promise<{ready: boolean, domain: string|null, validationToken: string|null}>}
 */
export async function onboardDomain(secretKey, domain = null, options = {}) {
  const { projectId = process.env.SCALEWAY_DEFAULT_PROJECT_ID, validationTimeoutMs } = options;

  // Unreachable off a TTY in practice (the deploy only offers this on the
  // interactive path), but the invariant is 'any function that prompts,
  // guards first' — see saveIfWanted above.
  assertInteractiveStdin({
    what: 'the domain to add to Scaleway DNS',
    envVar: 'SCALEWAY_SECRET_KEY',
  });

  const suggestion = likelyRegistrableDomain(domain);
  const answer = await promptOrExit(
    p.text({
      message: 'Domain to add to Scaleway (the registrable name, not a subdomain)',
      initialValue: suggestion,
      placeholder: suggestion || 'example.com',
      validate: (v) => {
        if (!v?.includes('.')) return 'Enter a domain like example.com';
        return undefined;
      },
    }),
  );
  const target = String(answer).trim().replace(/\.$/, '').toLowerCase();

  const s = spinner();
  s.start(`Checking whether Scaleway manages ${target}`);

  let registration;
  try {
    registration = await getExternalDomainRegistration(secretKey, target);
  } catch (error) {
    s.stop(`Could not check ${target}: ${error.message}`);
    return { ready: false, domain: target, validationToken: null };
  }

  // Read the LIVE delegation before deciding anything: it is what separates
  // "validated and usable" from "validated but nobody is asking Scaleway", and
  // "waiting" from "deadlocked".
  s.message(`Reading the current nameservers for ${target}`);
  const nameservers = await resolveNameservers(target);
  const pointingAtScaleway = delegatedToScaleway(nameservers);

  if (registration.found && registration.status === 'active') {
    if (pointingAtScaleway) {
      s.stop(`Scaleway already manages ${target}`);
      // The caller re-reads the zone list rather than trusting this — a
      // freshly-validated domain's zone can lag by a few seconds.
      return { ready: true, domain: target, validationToken: null };
    }
    s.stop(`${target} is validated, but its nameservers still point elsewhere`);
    displayNameserverStep(target);
    return { ready: false, domain: target, validationToken: null };
  }

  if (pointingAtScaleway) {
    // Publishing the TXT anywhere is futile now — resolvers follow the
    // delegation, and it leads to a host that will not answer.
    s.stop(`${target} delegates to Scaleway but has not validated`);
    displayDelegationDeadlock(target, nameservers);
    return { ready: false, domain: target, validationToken: registration.validationToken };
  }

  let validationToken = registration.validationToken;
  let createdAt = registration.createdAt;
  if (registration.found) {
    s.stop(
      `${target} is already pending on Scaleway (status: ${registration.status ?? 'unknown'})`,
    );
  } else {
    s.message(`Adding ${target} as an external domain`);
    try {
      ({ validationToken, createdAt } = await registerExternalDomain(secretKey, target, projectId));
      s.stop(`${target} added, Scaleway is now waiting for proof of ownership`);
    } catch (error) {
      s.stop(`Could not add ${target}: ${error.message}`);
      return { ready: false, domain: target, validationToken: null };
    }
  }

  const deadline = validationDeadline(createdAt);

  // Can we publish the ownership record ourselves? Only if the domain's
  // CURRENT DNS is a backend we drive — Scaleway itself is excluded because,
  // by construction, it does not serve this domain yet.
  let host = null;
  if (validationToken) {
    const hostSpinner = spinner();
    hostSpinner.start(`Looking for ${target} in your other DNS accounts`);
    try {
      host = await locateDomainBackend(target, { exclude: ['scaleway'] });
    } catch {
      host = null;
    }
    hostSpinner.stop(
      host
        ? `${target} is hosted in ${DNS_PROVIDERS[host.providerId].name}`
        : `No account of yours currently serves ${target}`,
    );
  }

  let publishedVia = null;
  if (host) {
    const hostName = DNS_PROVIDERS[host.providerId].name;
    const publish = await promptOrExit(
      p.confirm({
        message: `Publish the ${EXTERNAL_DOMAIN_CHALLENGE_NAME} record to ${hostName} now?`,
        initialValue: true,
      }),
    );

    if (publish) {
      const publishSpinner = spinner();
      publishSpinner.start(`Writing ${EXTERNAL_DOMAIN_CHALLENGE_NAME}.${target} in ${hostName}`);
      try {
        const { createDNSRecord } = await getDnsProvider(host.providerId);
        await createDNSRecord(host.token, String(host.zone.id), {
          type: 'TXT',
          name: `${EXTERNAL_DOMAIN_CHALLENGE_NAME}.${target}`,
          value: validationToken,
        });
        publishedVia = hostName;
        publishSpinner.stop(`Ownership record published in ${hostName}`);
      } catch (error) {
        publishSpinner.stop(`Could not publish to ${hostName}: ${error.message}`);
      }
    }
  }

  if (publishedVia) {
    const waitSpinner = spinner();
    waitSpinner.start('Waiting for Scaleway to verify the record');
    const { active, status } = await waitForExternalDomainActive(secretKey, target, {
      ...(validationTimeoutMs === undefined ? {} : { timeoutMs: validationTimeoutMs }),
      onTick: (elapsedMs) =>
        waitSpinner.message(
          `Waiting for Scaleway to verify the record (${Math.round(elapsedMs / 1000)}s)`,
        ),
    });

    if (active) {
      waitSpinner.stop(`${target} validated`);
      displayNameserverStep(target);
      return { ready: false, domain: target, validationToken };
    }
    waitSpinner.stop(
      `Still ${status ?? 'checking'} — Scaleway verifies on its own schedule, so this can take a while`,
    );
  }

  displayExternalDomainInstructions(target, { validationToken, deadline, publishedVia });
  return { ready: false, domain: target, validationToken };
}

/**
 * Get Object Storage (S3-compatible) credentials — on Scaleway these ARE
 * the compute credentials (one IAM pair signs both, audit-verified), so
 * this maps the pair from env when present and otherwise runs the same
 * triple flow as getApiToken.
 *
 * @param {string} [projectName]
 * @param {{ save?: boolean, force?: boolean, skipPrompts?: boolean }} [options]
 *   skipPrompts: never fall through to the interactive prompt — return
 *   null instead when env vars are missing (same non-TTY contract as the
 *   sibling modules).
 * @returns {Promise<{accessKey: string, secretKey: string}|null>}
 */
export async function getS3Credentials(projectName, options = {}) {
  const { save = true, force = false, skipPrompts = false } = options;

  if (!force) {
    const envAccessKey = process.env.SCALEWAY_ACCESS_KEY;
    const envSecretKey = process.env.SCALEWAY_SECRET_KEY;

    if (envAccessKey && envSecretKey) {
      p.log.info(
        '✓ Using Object Storage credentials from SCALEWAY_* environment variables (same IAM pair as compute)',
      );
      return { accessKey: envAccessKey, secretKey: envSecretKey };
    }
  }

  if (skipPrompts) return null;

  displayS3CredentialsGuide(projectName);

  // The triple flow collects (and validates) the pair; force so a partial
  // env doesn't short-circuit the collection this call exists to do.
  const secretKey = await getApiToken(projectName, { save, force: true });
  const accessKey = process.env.SCALEWAY_ACCESS_KEY;
  if (!secretKey || !accessKey) return null;

  p.log.success('Object Storage credentials received!');
  return { accessKey, secretKey };
}
