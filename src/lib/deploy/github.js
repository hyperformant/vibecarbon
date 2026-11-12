/**
 * GitHub Integration & Workflows
 * Logic for repository setup, branches and pushes, and watching a deploy's
 * workflow run
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { spinner } from '../cli/progress.js';
import { runCommand } from '../command.js';
import { buildGitAddArgv } from '../project.js';

/**
 * Check if GitHub CLI is authenticated
 * @returns {boolean}
 */
export function checkGitHubAuth() {
  try {
    const result = runCommand('gh auth status', {
      cleanEnv: true,
      silent: true,
      ignoreError: true,
    });
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
    const result = runCommand('gh api user -q .login', {
      cleanEnv: true,
      silent: true,
      ignoreError: true,
    });
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
      cleanEnv: true,
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
      cleanEnv: true,
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
    runCommand('git init', { silent: true, cleanEnv: true });
    s.stop('Git repository initialized');
  }

  // Ensure we have at least one commit
  const hasCommits = runCommand('git rev-parse HEAD', {
    silent: true,
    ignoreError: true,
    cleanEnv: true,
  });
  if (!hasCommits) {
    s.start('Creating initial commit');
    runCommand(buildGitAddArgv(), { silent: true, ignoreError: true, cleanEnv: true });
    runCommand('git commit -m "Initial commit - Vibecarbon project"', {
      silent: true,
      cleanEnv: true,
    });
    s.stop('Initial commit created');
  }

  s.start(`Creating GitHub repository: ${projectName}`);
  try {
    // Create repo with source and remote in one command
    runCommand(['gh', 'repo', 'create', projectName, visibility, '--source=.', '--remote=origin'], {
      cleanEnv: true,
      silent: true,
      timeout: 60000,
    });
    s.stop('GitHub repository created');

    // Get the repo URL
    const repoUrl = runCommand('gh repo view --json url -q .url', {
      cleanEnv: true,
      silent: true,
    })?.trim();
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
  runCommand(buildGitAddArgv(process.cwd(), [workflowPath]), {
    silent: true,
    ignoreError: true,
    cleanEnv: true,
  });
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
        cleanEnv: true,
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
      cleanEnv: true,
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
