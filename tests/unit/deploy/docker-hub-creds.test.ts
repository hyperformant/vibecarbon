import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDockerHubCreds } from '../../../src/lib/deploy/docker-hub.js';

// A3 sweep: resolveDockerHubCreds() was duplicated near-identically in
// orchestrator.js and scale.js (both env-first-then-credentials-file); the
// credentials-file leg died with A3 (Docker Hub is operator-shell-level
// only — see config-registry.js's operator-secret class docblock), leaving
// a pure env read shared from src/lib/deploy/docker-hub.js.

const ambient = {
  username: process.env.DOCKER_HUB_USERNAME,
  token: process.env.DOCKER_HUB_TOKEN,
};

beforeEach(() => {
  delete process.env.DOCKER_HUB_USERNAME;
  delete process.env.DOCKER_HUB_TOKEN;
});

afterEach(() => {
  if (ambient.username === undefined) delete process.env.DOCKER_HUB_USERNAME;
  else process.env.DOCKER_HUB_USERNAME = ambient.username;
  if (ambient.token === undefined) delete process.env.DOCKER_HUB_TOKEN;
  else process.env.DOCKER_HUB_TOKEN = ambient.token;
});

describe('resolveDockerHubCreds', () => {
  it('returns { username, token } when both env vars are set', () => {
    process.env.DOCKER_HUB_USERNAME = 'acme';
    process.env.DOCKER_HUB_TOKEN = 'dckr_pat_abc';
    expect(resolveDockerHubCreds()).toEqual({ username: 'acme', token: 'dckr_pat_abc' });
  });

  it('returns null when neither is set', () => {
    expect(resolveDockerHubCreds()).toBeNull();
  });

  it('returns null when only username is set (both required)', () => {
    process.env.DOCKER_HUB_USERNAME = 'acme';
    expect(resolveDockerHubCreds()).toBeNull();
  });

  it('returns null when only token is set (both required)', () => {
    process.env.DOCKER_HUB_TOKEN = 'dckr_pat_abc';
    expect(resolveDockerHubCreds()).toBeNull();
  });
});
