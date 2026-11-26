/**
 * The credential a private app image at ghcr.io is pulled with, whatever
 * holds it: a GitHub classic token with only read:packages. A cluster keeps
 * it as a Secret (k8s/ghcr-pull-secret.js), a compose server in its docker
 * login file.
 *
 * resolveGhcrPull resolves it once per run. A package anyone can pull needs
 * none. A token already in one of the stores that still passes the checks
 * below is reused, so a rerun does not ask. Otherwise the token comes from
 * GHCR_PULL_TOKEN in the operator's shell or, on a terminal, from one ask,
 * and it replaces any stored token that failed.
 *
 * A token is refused before it is stored or copied anywhere unless GitHub
 * says its scopes (the x-oauth-scopes header on its own /user call) are
 * exactly read:packages: anyone who can read the store can read it. A token
 * GitHub sends no scope header for (a fine-grained one) is refused as not
 * classic, and so is one GitHub no longer accepts. A stored token is checked
 * the same way each run, since a classic token's scopes can be widened after
 * it was made.
 *
 * The token goes only into Authorization headers to api.github.com and
 * ghcr.io. It is never in a URL, an argv, a file, a log or an error message.
 */

import * as p from '@clack/prompts';
import { exitCancelled } from '../cli/exit-guard.js';
import { link } from '../colors.js';
import { registryEntry } from '../config-registry.js';
import { environmentForStack } from '../environment-name.js';
import { fetchWithRetry } from '../fetch-retry.js';
import { normalizeOperatorValue, readOperatorVar } from '../operator-env.js';

/** The operator variable a headless run reads the token from. */
const TOKEN_ENV = 'GHCR_PULL_TOKEN';

/** GitHub's new classic token page with only read:packages ticked. */
const READ_PACKAGES_TOKEN_PAGE = 'https://github.com/settings/tokens/new?scopes=read:packages';

/**
 * The new-token page, with a description that says which cluster the token
 * is for.
 *
 * @param {{ projectName: string, envName: string }} args - envName is the
 *   operator's environment (`prod`)
 * @returns {string}
 */
export function newPullTokenUrl({ projectName, envName }) {
  const description = encodeURIComponent(`${projectName} ${envName} image pulls`);
  return `${READ_PACKAGES_TOKEN_PAGE}&description=${description}`;
}

/**
 * ghcr's token, tags and manifest endpoints for a package. ghcr paths are
 * lowercase, whatever case GitHub spells the owner in.
 */
export function ghcrEndpoints(owner, repo) {
  const path = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  return {
    image: `ghcr.io/${path}`,
    token: `https://ghcr.io/token?scope=repository:${path}:pull&service=ghcr.io`,
    tags: `https://ghcr.io/v2/${path}/tags/list`,
    manifest: (tag) => `https://ghcr.io/v2/${path}/manifests/${tag}`,
  };
}

/**
 * Every manifest type a build can publish under a tag: an OCI image index or
 * manifest, a Docker manifest list or v2 manifest. All four are accepted, so
 * the HEAD finds the tag whichever type the build pushed.
 */
export const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * Every character a GitHub token can have. Checked before the token goes in a
 * header: fetch refuses a header value with a space or a control character
 * in it, and its error quotes the value.
 */
const TOKEN_CHARS = /^[\x21-\x7e]+$/;

/**
 * Who a token belongs to and what it may do, as GitHub says on its /user
 * call: `scopes` is the x-oauth-scopes header split, or null when there is
 * none (a token that is not classic).
 *
 * An error for a token that is no good, whatever the moment (unreadable,
 * refused, or not a kind /user takes), carries `shortfall`: what is wrong
 * with it, to follow "the token". Any other error (github down, rate
 * limited) carries none.
 *
 * @param {string} token
 * @param {{ fetcher?: typeof fetchWithRetry }} [options]
 * @returns {Promise<{ login: string, scopes: string[] | null }>}
 */
export async function githubTokenScopes(token, { fetcher = fetchWithRetry } = {}) {
  const noGood = (message, shortfall) => Object.assign(new Error(message), { shortfall });
  if (!TOKEN_CHARS.test(token)) {
    throw noGood(
      'that has a space or a character no github token has, so it was sent nowhere. ' +
        'copy the token again, all of it and nothing else.',
      'is not a token github could read',
    );
  }
  const res = await fetcher('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}` },
    label: 'api.github.com',
  });
  if (res.status === 401) {
    throw noGood(
      'github did not accept that token. it may be cut short, expired or revoked, so make a new one.',
      'is one github no longer accepts',
    );
  }
  if (res.status === 403) {
    throw noGood(
      "that is not one github's /user accepts, so github will not say what it may do. " +
        `make a classic token with only read:packages here: ${READ_PACKAGES_TOKEN_PAGE}`,
      'is not a classic token',
    );
  }
  if (!res.ok) {
    const later = res.status === 429 || res.status >= 500 ? ' try again in a minute.' : '';
    throw new Error(`github answered ${res.status} when asked what that token may do.${later}`);
  }
  const { login } = await res.json();
  if (typeof login !== 'string' || !login) {
    throw new Error('github did not say whose token that is. try again in a minute.');
  }
  const header = res.headers.get('x-oauth-scopes');
  return {
    login,
    scopes:
      header === null
        ? null
        : header
            .split(',')
            .map((scope) => scope.trim())
            .filter(Boolean),
  };
}

/**
 * What keeps a token with these scopes from being the pull token: `said`
 * follows "the token", `why` says what it means. Null when its one scope is
 * read:packages.
 */
function scopeShortfall(scopes) {
  if (scopes === null) {
    return { said: 'is not a classic token', why: 'so github will not say what it may do' };
  }
  const extra = scopes.filter((scope) => scope !== 'read:packages');
  if (extra.length > 0) {
    return {
      said: `can also ${extra.join(', ')}`,
      why: `and it lives in your cluster as ghcr-pull-secret, where anyone who can read Secrets can use it`,
    };
  }
  if (!scopes.includes('read:packages')) {
    return { said: 'cannot read packages', why: 'so the cluster could not pull with it' };
  }
  return null;
}

/**
 * Why a token with these scopes may not be the pull token, or null when its
 * one scope is read:packages.
 *
 * @param {string[] | null} scopes - githubTokenScopes's; null is not classic
 * @returns {string | null}
 */
export function pullTokenProblem(scopes) {
  const shortfall = scopeShortfall(scopes);
  if (!shortfall) return null;
  return (
    `that token ${shortfall.said}, ${shortfall.why}. ` +
    `make a classic token with only read:packages here: ${READ_PACKAGES_TOKEN_PAGE}`
  );
}

/**
 * Ask ghcr for a pull token on the package, anonymously or with `basic` (a
 * GitHub token's Basic pair). Null when ghcr refuses it; ghcr not answering
 * throws.
 */
export async function ghcrBearer({ owner, repo, fetcher, basic }) {
  const { image, token } = ghcrEndpoints(owner, repo);
  const grant = await fetcher(token, {
    ...(basic && { headers: { Authorization: `Basic ${basic}` } }),
    label: 'ghcr.io',
  });
  if (grant.status === 401 || grant.status === 403) return null;
  if (!grant.ok) {
    throw new Error(
      `ghcr.io answered ${grant.status} when asked to pull ${image}. try again in a minute.`,
    );
  }
  const { token: bearer } = await grant.json();
  if (typeof bearer !== 'string' || !bearer) {
    throw new Error(`ghcr.io gave no pull token for ${image}. try again in a minute.`);
  }
  return bearer;
}

/**
 * Ask ghcr for a pull token on the package (ghcrBearer), then list its tags
 * with it. Null when ghcr refuses the pull token itself; otherwise the tags
 * answer's status.
 */
async function ghcrTagsStatus({ owner, repo, fetcher, basic }) {
  const bearer = await ghcrBearer({ owner, repo, fetcher, basic });
  if (bearer === null) return null;
  const tags = await fetcher(ghcrEndpoints(owner, repo).tags, {
    headers: { Authorization: `Bearer ${bearer}` },
    label: 'ghcr.io',
  });
  return tags.status;
}

/** A tags answer that is neither yes nor no. */
function unexpectedTags(status, owner, repo) {
  return new Error(
    `ghcr.io answered ${status} when asked for the tags of ${ghcrEndpoints(owner, repo).image}. ` +
      'try again in a minute.',
  );
}

/**
 * Whether anyone can pull the package, with no credential at all. A private
 * package and one not published yet both say no.
 *
 * @param {{ owner: string, repo: string, fetcher?: typeof fetchWithRetry }} args
 * @returns {Promise<boolean>}
 */
export async function ghcrPullsAnonymously({ owner, repo, fetcher = fetchWithRetry }) {
  const status = await ghcrTagsStatus({ owner, repo, fetcher });
  if (status === null || status === 401 || status === 403 || status === 404) return false;
  if (status === 200) return true;
  throw unexpectedTags(status, owner, repo);
}

/**
 * Whether ghcr lets this token pull the package. A package not published yet
 * (no tags, 404) still counts: ghcr knew the token, and the first build will
 * publish what it pulls.
 *
 * @param {{ owner: string, repo: string, username: string, token: string,
 *   fetcher?: typeof fetchWithRetry }} args
 * @returns {Promise<boolean>}
 */
export async function ghcrAcceptsToken({ owner, repo, username, token, fetcher = fetchWithRetry }) {
  const basic = Buffer.from(`${username}:${token}`).toString('base64');
  const status = await ghcrTagsStatus({ owner, repo, fetcher, basic });
  if (status === null || status === 401 || status === 403) return false;
  if (status === 200 || status === 404) return true;
  throw unexpectedTags(status, owner, repo);
}

/**
 * What keeps a token read back from a store from being used again, checked
 * as a new token is: its scopes at github (a token widened since, or
 * revoked, fails here), then ghcr. Null when it can be reused. Github or
 * ghcr not answering throws: that says nothing about the token.
 */
async function storedTokenShortfall({ owner, repo, stored, fetcher }) {
  let scopes;
  try {
    ({ scopes } = await githubTokenScopes(stored.token, { fetcher }));
  } catch (err) {
    if (err.shortfall) return err.shortfall;
    throw err;
  }
  const shortfall = scopeShortfall(scopes);
  if (shortfall) return shortfall.said;
  if (!(await ghcrAcceptsToken({ owner, repo, ...stored, fetcher }))) {
    return 'is one ghcr.io no longer accepts';
  }
  return null;
}

/**
 * A token the operator gives this run: GHCR_PULL_TOKEN from the shell, else
 * one ask on a terminal. `from` names where it came from in a refusal.
 * `stale` says which store's token is not used again, and why; `keptAs` says
 * where the new one will live.
 */
async function newPullToken({ image, envName, projectName, keptAs, isTTY, prompt, stale }) {
  const shell = readOperatorVar(TOKEN_ENV);
  if (shell.problem) throw new Error(shell.problem);
  const pageUrl = newPullTokenUrl({ projectName, envName });
  if (!shell.value && !isTTY) {
    throw new Error(
      [
        ...stale.map((line) => `${line}, so it is not used again.`),
        `your app image at ${image} is private or not published yet, so ${envName} needs a token ` +
          `to pull it, and there is no terminal to ask for one. export ${TOKEN_ENV} as a classic ` +
          `token with only read:packages, made here: ${pageUrl}`,
      ].join('\n'),
    );
  }
  if (stale.length > 0) {
    p.log.warn(stale.map((line) => `${line}, so it gets replaced.`).join('\n'));
  }
  if (shell.value) return { token: shell.value, from: TOKEN_ENV };
  p.log.info(
    [
      `your app image at ${image} is private or not published yet, so ${envName} needs a token to pull it.`,
      `make a classic token with only read:packages here: ${link(pageUrl)}`,
      `it lives ${keptAs} and nowhere else, so give it nothing more.`,
    ].join('\n'),
  );
  const answer = await prompt({
    message: 'paste the token',
    validate: (value) => (value?.trim() ? undefined : 'paste the token, or press ctrl-c to stop'),
  });
  if (p.isCancel(answer)) exitCancelled();
  return {
    token: normalizeOperatorValue(answer, registryEntry(TOKEN_ENV)).value,
    from: 'the token you pasted',
  };
}

/**
 * @typedef {{ mode: 'public' } | { mode: 'token', username: string, token: string }} GhcrPull
 */

/**
 * Somewhere a pull token is kept, read without printing it. `name` completes
 * "the token ___" (`in prod's cluster`, `on prod's server`).
 *
 * @typedef {{ name: string,
 *   read: () => Promise<{ username: string, token: string } | null> }} PullStore
 */

/**
 * The pull credential for every store of the environment, resolved once:
 * public when anyone can pull the package; else the first token stored in a
 * store, in order, that passes the same checks as a new one; else a new token
 * (GHCR_PULL_TOKEN, or one ask on a terminal). A token is refused with the
 * reason unless github says its scopes are exactly read:packages and ghcr
 * lets it pull the package. A stored token that fails is not reused or
 * copied to another store: whatever this returns replaces it. Nothing is
 * written here.
 *
 * @param {{ owner: string, repo: string, projectName: string, envName: string,
 *   stores: PullStore[], keptAs: string,
 *   isTTY?: boolean, prompt?: (opts: { message: string,
 *   validate: (value: string) => string | undefined }) => Promise<unknown>,
 *   fetcher?: typeof fetchWithRetry }} args - envName is the operator's
 *   environment; stores are where it may already be kept (both sides of
 *   k8s-ha); keptAs completes "it lives ___" in the ask
 * @returns {Promise<GhcrPull>}
 */
export async function resolveGhcrPull({
  owner,
  repo,
  projectName,
  envName,
  stores,
  keptAs,
  isTTY = process.stdin.isTTY,
  prompt = (opts) => p.password(opts),
  fetcher = fetchWithRetry,
}) {
  if (await ghcrPullsAnonymously({ owner, repo, fetcher })) return { mode: 'public' };
  const stale = [];
  for (const store of stores) {
    const stored = await store.read();
    if (!stored) continue;
    const shortfall = await storedTokenShortfall({ owner, repo, stored, fetcher });
    if (!shortfall) {
      if (stale.length > 0) {
        p.log.warn(stale.map((line) => `${line}, so it gets replaced.`).join('\n'));
      }
      return { mode: 'token', ...stored };
    }
    stale.push(`the token ${store.name} ${shortfall}`);
  }
  const { image } = ghcrEndpoints(owner, repo);
  const { token, from } = await newPullToken({
    image,
    envName: environmentForStack(envName),
    projectName,
    keptAs,
    isTTY,
    prompt,
    stale,
  });
  const refuse = (why) => new Error(`${from} was not stored: ${why}`);
  let login;
  let scopes;
  try {
    ({ login, scopes } = await githubTokenScopes(token, { fetcher }));
  } catch (err) {
    throw refuse(err.message);
  }
  const problem = pullTokenProblem(scopes);
  if (problem) throw refuse(problem);
  if (!(await ghcrAcceptsToken({ owner, repo, username: login, token, fetcher }))) {
    throw refuse(
      `ghcr.io would not let it pull ${image}. make one as someone who can read that package: ` +
        newPullTokenUrl({ projectName, envName: environmentForStack(envName) }),
    );
  }
  return { mode: 'token', username: login, token };
}
