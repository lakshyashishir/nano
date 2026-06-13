/**
 * Git helpers for the Claude Code local adapter.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function workspaceDir(owner, repo) {
  return path.join(os.homedir(), '.nano', 'workspaces', `${owner}-${repo}`);
}

function authRemote(owner, repo, token) {
  if (token) {
    return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  }
  return `https://github.com/${owner}/${repo}.git`;
}

export async function prepareCheckout(task, token) {
  const dir = workspaceDir(task.github_owner, task.github_repo);
  const branch = task.github_branch || 'main';
  const remote = authRemote(task.github_owner, task.github_repo, token);

  await fs.mkdir(path.dirname(dir), { recursive: true });

  const hasGit = await fs
    .access(path.join(dir, '.git'))
    .then(() => true)
    .catch(() => false);

  if (hasGit) {
    await exec('git', ['fetch', 'origin'], { cwd: dir });
    await exec('git', ['checkout', branch], { cwd: dir });
    await exec('git', ['reset', '--hard', `origin/${branch}`], { cwd: dir });
  } else {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await exec('git', ['clone', '--depth', '1', '--branch', branch, remote, dir]);
  }

  return dir;
}

export async function createWorkBranch(dir, taskId) {
  const branch = `nano/${taskId.slice(0, 8)}`;
  await exec('git', ['checkout', '-B', branch], { cwd: dir });
  return branch;
}

export async function gitStatusPorcelain(dir) {
  const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: dir });
  return stdout.trim();
}

export async function commitAll(dir, message) {
  await exec('git', ['add', '-A'], { cwd: dir });
  const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: dir });
  if (!stdout.trim()) return false;
  await exec('git', ['commit', '-m', message], { cwd: dir });
  return true;
}

export async function pushBranch(dir, branch, owner, repo, token) {
  if (token) {
    await exec('git', ['remote', 'set-url', 'origin', authRemote(owner, repo, token)], { cwd: dir });
  }
  await exec('git', ['push', '-u', 'origin', branch], { cwd: dir });
}

export async function createPullRequest(task, branch, token) {
  if (!token) return null;
  const res = await fetch(`https://api.github.com/repos/${task.github_owner}/${task.github_repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'nano-claude-adapter',
    },
    body: JSON.stringify({
      title: `nano: ${task.description.slice(0, 80)}`,
      head: branch,
      base: task.github_branch || 'main',
      body: `## Nano + Claude Code\n\n**Task:** ${task.description}\n\nExecuted locally via Claude Code adapter.`,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PR failed: ${res.status} ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.html_url;
}

export function branchUrl(task, branch) {
  return `https://github.com/${task.github_owner}/${task.github_repo}/tree/${branch}`;
}
