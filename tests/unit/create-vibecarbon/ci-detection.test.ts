import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCI } from '../../../src/create.js';

describe('isCI', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all CI-related env vars
    delete process.env.CI;
    delete process.env.CONTINUOUS_INTEGRATION;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.CIRCLECI;
    delete process.env.JENKINS_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns false when no CI environment variables are set', () => {
    expect(isCI()).toBe(false);
  });

  it('detects CI=true', () => {
    process.env.CI = 'true';
    expect(isCI()).toBe(true);
  });

  it('does not detect CI=false', () => {
    process.env.CI = 'false';
    expect(isCI()).toBe(false);
  });

  it('detects CONTINUOUS_INTEGRATION=true', () => {
    process.env.CONTINUOUS_INTEGRATION = 'true';
    expect(isCI()).toBe(true);
  });

  it('detects GITHUB_ACTIONS=true', () => {
    process.env.GITHUB_ACTIONS = 'true';
    expect(isCI()).toBe(true);
  });

  it('detects GITLAB_CI=true', () => {
    process.env.GITLAB_CI = 'true';
    expect(isCI()).toBe(true);
  });

  it('detects CIRCLECI=true', () => {
    process.env.CIRCLECI = 'true';
    expect(isCI()).toBe(true);
  });

  it('detects JENKINS_URL when defined', () => {
    process.env.JENKINS_URL = 'http://jenkins.example.com';
    expect(isCI()).toBe(true);
  });

  it('returns true if any CI environment is set', () => {
    // Test combinations
    process.env.CI = 'true';
    process.env.GITHUB_ACTIONS = 'true';
    expect(isCI()).toBe(true);
  });
});
