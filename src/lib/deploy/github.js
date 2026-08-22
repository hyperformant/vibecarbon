/**
 * GitHub Integration & Workflows
 * Logic for repository setup, environment secrets, and CI/CD generation
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { spinner } from '../cli/progress.js';
import { c } from '../colors.js';
import { checkDependency, runCommand } from '../command.js';
import { buildGitAddArgv } from '../project.js';

/**
 * Check if GitHub CLI is authenticated
 * @returns {boolean}
 */
export function checkGitHubAuth() {
  try {
    const result = runCommand('gh auth status', { silent: true, ignoreError: true });
    return result !== null && result !== false;
  } catch {
    return false;
  }
}

/**
 * Get the authenticated GitHub username
 * @returns {string|null}
 */
export function getGitHubUsername() {
  try {
    const result = runCommand('gh api user -q .login', { silent: true, ignoreError: true });
    return result?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if a GitHub repo already exists for this directory
 * @returns {string|null}
 */
export function checkExistingRepo() {
  try {
    const result = runCommand('gh repo view --json nameWithOwner -q .nameWithOwner', {
      silent: true,
      ignoreError: true,
    });
    return result?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if git remote 'origin' is configured
 * @returns {string|null}
 */
export function checkGitRemote() {
  try {
    const result = runCommand('git remote get-url origin', {
      silent: true,
      ignoreError: true,
    });
    return result?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Create a GitHub repository for the project
 * @param {string} projectName
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function createGitHubRepository(projectName, options = {}) {
  const s = spinner();
  const visibility = options.isPublic ? '--public' : '--private';

  // Ensure we have a git repo
  if (!existsSync(join(process.cwd(), '.git'))) {
    s.start('Initializing git repository');
    runCommand('git init', { silent: true });
    s.stop('Git repository initialized');
  }

  // Ensure we have at least one commit
  const hasCommits = runCommand('git rev-parse HEAD', { silent: true, ignoreError: true });
  if (!hasCommits) {
    s.start('Creating initial commit');
    runCommand(buildGitAddArgv(), { silent: true, ignoreError: true });
    runCommand('git commit -m "Initial commit - Vibecarbon project"', { silent: true });
    s.stop('Initial commit created');
  }

  s.start(`Creating GitHub repository: ${projectName}`);
  try {
    // Create repo with source and remote in one command
    runCommand(['gh', 'repo', 'create', projectName, visibility, '--source=.', '--remote=origin'], {
      silent: true,
      timeout: 60000,
    });
    s.stop('GitHub repository created');

    // Get the repo URL
    const repoUrl = runCommand('gh repo view --json url -q .url', { silent: true })?.trim();
    return { success: true, url: repoUrl, name: projectName };
  } catch (error) {
    s.stop('Failed to create GitHub repository');
    return { success: false, error: error.message };
  }
}

/**
 * Commit changes and push to GitHub to trigger deployment
 * @param {string} branchName
 * @param {string} workflowPath
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function commitAndPush(branchName, workflowPath, options = {}) {
  const s = spinner();
  const skipCiStr = options.skipCi ? ' [skip ci]' : '';

  // Stage the workflow file
  s.start('Staging deployment workflow');
  runCommand(buildGitAddArgv(process.cwd(), [workflowPath]), { silent: true, ignoreError: true });
  s.stop('Changes staged');

  // Commit
  s.start('Committing changes');
  const commitMessage = `Add deployment workflow and configuration${skipCiStr}`;
  const commitResult = runCommand(['git', 'commit', '-m', commitMessage], {
    silent: true,
    ignoreError: true,
    cleanEnv: true,
  });
  if (!commitResult) {
    s.stop('No new changes to commit');
  } else {
    s.stop('Changes committed');
  }

  // Push
  s.start(`Pushing to ${branchName} branch`);
  try {
    runCommand(['git', 'push', '-u', 'origin', branchName], {
      silent: true,
      timeout: 60000,
      cleanEnv: true,
    });
    s.stop(`Code pushed to ${branchName}`);
    return { success: true };
  } catch (error) {
    s.stop(`Failed to push: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Monitor GitHub Actions deployment progress
 * @param {string} _repoName
 * @param {number} timeout
 * @returns {Promise<object>}
 */
export async function monitorDeployment(_repoName, timeout = 600000) {
  const s = spinner();
  s.start('Waiting for GitHub Actions deployment');

  const startTime = Date.now();
  let lastStatus = '';

  while (Date.now() - startTime < timeout) {
    try {
      const result = runCommand('gh run list --limit 1 --json status,conclusion,name,url', {
        silent: true,
        ignoreError: true,
      });

      if (result) {
        const runs = JSON.parse(result);
        if (runs.length > 0) {
          const run = runs[0];
          const status = run.status;

          if (status !== lastStatus) {
            lastStatus = status;
            if (status === 'completed') {
              if (run.conclusion === 'success') {
                s.stop('Deployment complete!');
                return { success: true, url: run.url };
              }
              s.stop(`Deployment ${run.conclusion}`);
              return { success: false, conclusion: run.conclusion, url: run.url };
            }
            s.message(`Deployment ${status}...`);
          }
        }
      }
    } catch {
      // Ignore errors, keep polling
    }

    await new Promise((r) => setTimeout(r, 10000));
  }

  s.stop('Deployment monitoring timed out');
  return { success: false, timedOut: true };
}

/**
 * Orchestrate GitHub integration setup
 * @param {object} projectConfig
 * @param {string} _branchName
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function setupGitHubIntegration(projectConfig, _branchName, options = {}) {
  const { defaultCreate = true, isPublic = false, skipPrompts = false } = options;

  // Check if gh CLI is available and authenticated
  if (!checkDependency('gh', 'GitHub CLI')) {
    p.log.warn('GitHub CLI (gh) not installed - skipping automatic GitHub setup');
    return { skipped: true, reason: 'gh_not_installed' };
  }

  if (!checkGitHubAuth()) {
    p.log.warn('GitHub CLI not authenticated');
    p.log.info('Run: gh auth login');
    return { skipped: true, reason: 'not_authenticated' };
  }

  // Check for existing repo
  const existingRepo = checkExistingRepo();
  const existingRemote = checkGitRemote();

  if (existingRepo) {
    p.log.info(`Using existing repository: ${c.bold(existingRepo)}`);
    return { existing: true, repoName: existingRepo };
  }

  if (existingRemote && !existingRemote.includes('github.com')) {
    p.log.warn(`Git remote points to non-GitHub URL: ${existingRemote}`);
    if (!skipPrompts) {
      const replace = await p.confirm({
        message: 'Replace with GitHub remote?',
        initialValue: false,
      });
      if (!replace) {
        return { skipped: true, reason: 'non_github_remote' };
      }
      runCommand('git remote remove origin', { silent: true, ignoreError: true });
    } else {
      return { skipped: true, reason: 'non_github_remote' };
    }
  }

  // Prompt for repo creation
  let shouldCreate = defaultCreate;
  if (!skipPrompts) {
    shouldCreate = await p.confirm({
      message: 'Create GitHub repository for auto deployment (CI/CD)?',
      initialValue: true,
    });
  }

  if (!shouldCreate) {
    return { skipped: true, reason: 'user_declined' };
  }

  // Ask about visibility
  let repoIsPublic = isPublic;
  if (!skipPrompts && shouldCreate) {
    const visibility = await p.select({
      message: 'Repository visibility',
      options: [
        { value: 'private', label: 'Private', hint: 'recommended' },
        { value: 'public', label: 'Public' },
      ],
      initialValue: 'private',
    });
    repoIsPublic = visibility === 'public';
  }

  // Create the repository
  const result = await createGitHubRepository(projectConfig.projectName, {
    isPublic: repoIsPublic,
  });

  if (result.success) {
    return { created: true, repoName: projectConfig.projectName, url: result.url };
  }

  p.log.error(`Failed to create repository: ${result.error}`);
  return { skipped: true, reason: 'creation_failed', error: result.error };
}

/**
 * Setup GitHub environment and secrets
 * @param {string} _projectName
 * @param {string} envName
 * @param {object} secrets
 * @returns {Promise<boolean>}
 */
export async function setupGitHubEnvironment(_projectName, envName, secrets) {
  const s = spinner();
  s.start(`Setting up GitHub environment: ${envName}`);

  try {
    const repoInfo = runCommand('gh repo view --json nameWithOwner -q .nameWithOwner', {
      silent: true,
    }).trim();

    // Create environment
    runCommand(['gh', 'api', `repos/${repoInfo}/environments/${envName}`, '-X', 'PUT'], {
      silent: true,
      ignoreError: true,
    });

    // Set secrets for the environment
    for (const [key, value] of Object.entries(secrets)) {
      if (value && typeof value === 'string' && value.length > 0) {
        runCommand(['gh', 'secret', 'set', key, '--env', envName, '--body', value], {
          silent: true,
          ignoreError: true,
        });
      }
    }

    s.stop(`GitHub environment '${envName}' configured`);
    return true;
  } catch (error) {
    s.stop(`Failed to setup GitHub environment: ${error.message}`);
    return false;
  }
}

/**
 * Create or checkout a git branch for deployment
 * @param {string} branchName
 * @returns {Promise<boolean>}
 */
export async function createGitBranch(branchName) {
  const s = spinner();

  if (branchName === 'main' || branchName === 'master') {
    p.log.info(`Using '${branchName}' branch for deployment (push manually when ready)`);
    return true;
  }

  try {
    const hasCommits = runCommand('git rev-parse HEAD', {
      silent: true,
      ignoreError: true,
    });
    if (!hasCommits) {
      p.log.warn(`No commits yet - create initial commit, then run: git checkout -b ${branchName}`);
      return true;
    }

    const currentBranch = runCommand(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      cleanEnv: true,
    }).trim();

    const existsLocally = runCommand(['git', 'rev-parse', '--verify', branchName], {
      silent: true,
      ignoreError: true,
      cleanEnv: true,
    });

    if (existsLocally) {
      s.start(`Checking out existing branch: ${branchName}`);
      runCommand(['git', 'checkout', branchName], { silent: true, cleanEnv: true });
      s.stop(`Switched to branch '${branchName}'`);
    } else {
      s.start(`Creating branch '${branchName}' from '${currentBranch}'`);
      runCommand(['git', 'checkout', '-b', branchName], { silent: true, cleanEnv: true });
      s.stop(`Created branch '${branchName}' from '${currentBranch}'`);
    }

    p.log.info(`Push when ready: git push -u origin ${branchName}`);
    return true;
  } catch (error) {
    s.stop(`Failed to create branch: ${error.message}`);
    return false;
  }
}
