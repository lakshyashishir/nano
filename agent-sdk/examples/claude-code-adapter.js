/**
 * Claude Code adapter — real local coding agent for Nano.
 *
 * Polls Nano for `runner=local` tasks, clones the repo, runs Claude Code,
 * streams logs, asks approval before git push, then opens a PR.
 *
 * Setup:
 *   1. npm run agent:claude          # registers agent, prints API key
 *   2. export NANO_API_KEY=...       # save the key
 *   3. export GITHUB_TOKEN=...       # for clone/push/PR
 *   4. npm run agent:claude          # start polling
 *
 * Env:
 *   NANO_URL          — default https://nano.lakshyashishir1.workers.dev (or http://127.0.0.1:8787)
 *   NANO_API_KEY      — from registration step
 *   GITHUB_TOKEN      — repo write access
 *   CLAUDE_BIN        — default `claude`
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import NanoClient from '../index.js';
import {
  branchUrl,
  commitAll,
  createPullRequest,
  createWorkBranch,
  gitStatusPorcelain,
  prepareCheckout,
  pushBranch,
} from '../lib/git.js';

const BASE_URL = process.env.NANO_URL || process.env.HARNESS_URL || 'https://nano.lakshyashishir1.workers.dev';
const POLL_MS = Number(process.env.NANO_POLL_MS || 2000);
const WAKE_PORT = process.env.RUNNER_WAKE_PORT ? Number(process.env.RUNNER_WAKE_PORT) : null;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildPrompt(task) {
  return `${task.description}

Context:
- Repository: ${task.github_owner}/${task.github_repo}
- Base branch: ${task.github_branch || 'main'}
- You are in a local git checkout. Make real code/file changes in this directory.
- Do NOT run git push — Nano will handle git after you finish.`;
}

function summarizeStreamEvent(ev) {
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    const parts = [];
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text?.trim()) parts.push(block.text.trim());
      if (block.type === 'tool_use') parts.push(`→ ${block.name}`);
    }
    return parts.join(' ').slice(0, 500) || null;
  }
  if (ev.type === 'user' && ev.message?.content) {
    const tool = ev.message.content.find((b) => b.type === 'tool_result');
    if (tool?.content) return `✓ tool result`;
  }
  if (ev.type === 'result' && ev.result) return String(ev.result).slice(0, 300);
  return null;
}

async function runClaudeCode(client, task, cwd) {
  const args = [
    '-p',
    buildPrompt(task),
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
  ];

  await client.log(task.id, 'Claude Code running…', 'info');

  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let lastLogAt = 0;

    const flushLine = async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const ev = JSON.parse(trimmed);
        const msg = summarizeStreamEvent(ev);
        if (msg && Date.now() - lastLogAt > 400) {
          lastLogAt = Date.now();
          await client.log(task.id, msg, 'info');
        }
        if (ev.type === 'result') {
          resolve(ev);
        }
      } catch {
        if (trimmed.length > 2 && Date.now() - lastLogAt > 800) {
          lastLogAt = Date.now();
          await client.log(task.id, trimmed.slice(0, 280), 'debug');
        }
      }
    };

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) flushLine(line);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) client.log(task.id, text.slice(0, 280), 'warning');
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (buffer.trim()) flushLine(buffer);
      if (code === 0) resolve({ type: 'result', exitCode: 0 });
      else reject(new Error(`Claude Code exited with code ${code}`));
    });
  });
}

export class ClaudeCodeAdapter {
  constructor(client) {
    this.client = client;
  }

  async runTask(task) {
    if (!task.github_owner || !task.github_repo) {
      throw new Error('Task missing github_owner/github_repo');
    }

    await this.client.claimTask(task.id);
    await this.client.log(task.id, `Claimed: ${task.description}`, 'info');

    if (!GITHUB_TOKEN) {
      await this.client.log(task.id, 'GITHUB_TOKEN not set — clone/push may fail', 'warning');
    }

    await this.client.log(
      task.id,
      `Preparing ${task.github_owner}/${task.github_repo}…`,
      'info'
    );
    const dir = await prepareCheckout(task, GITHUB_TOKEN);
    const branch = await createWorkBranch(dir, task.id);
    await this.client.log(task.id, `Branch ${branch} ready`, 'info', { branch, dir });

    try {
      await runClaudeCode(this.client, task, dir);
    } catch (err) {
      await this.client.log(task.id, `Claude Code failed: ${err.message}`, 'error');
      await this.client.failTask(task.id, { summary: err.message });
      return;
    }

    const changes = await gitStatusPorcelain(dir);
    if (!changes) {
      await this.client.log(task.id, 'No file changes detected', 'warning');
      await this.client.completeTask(task.id, {
        summary: 'Claude Code finished with no git changes',
        branch,
        branchUrl: branchUrl(task, branch),
      });
      return;
    }

    await this.client.log(task.id, 'Requesting approval to push changes', 'warning');
    const approval = await this.client.requestApproval(task.id, 'git_push', {
      action: `Push branch ${branch} to ${task.github_owner}/${task.github_repo}`,
      branch,
      files: changes.split('\n').slice(0, 20),
      repo: `${task.github_owner}/${task.github_repo}`,
    });

    const decision = await this.client.waitForApproval(approval.id, 2000, 600000);
    if (decision !== 'approved') {
      await this.client.failTask(task.id, { summary: 'Push rejected by user', branch });
      return;
    }

    await this.client.log(task.id, 'Committing changes…', 'info');
    const committed = await commitAll(dir, `nano: ${task.description.slice(0, 72)}`);
    if (!committed) {
      await this.client.completeTask(task.id, { summary: 'Nothing to commit after approval' });
      return;
    }

    await this.client.log(task.id, `Pushing ${branch}…`, 'info');
    await pushBranch(dir, branch, task.github_owner, task.github_repo, GITHUB_TOKEN);

    let prUrl;
    try {
      prUrl = await createPullRequest(task, branch, GITHUB_TOKEN);
      if (prUrl) await this.client.log(task.id, 'Pull request opened', 'info', { prUrl });
    } catch (err) {
      await this.client.log(task.id, `PR skipped: ${err.message}`, 'warning');
    }

    await this.client.completeTask(task.id, {
      summary: prUrl
        ? `Claude Code opened PR on ${task.github_owner}/${task.github_repo}`
        : `Pushed ${branch} — open PR manually`,
      branch,
      branchUrl: branchUrl(task, branch),
      prUrl,
      runner: 'local',
      agent: 'claude-code',
    });
  }
}

async function main() {
  console.log(`🔗 Nano Claude Code adapter → ${BASE_URL}`);

  let client;
  const savedKey = process.env.NANO_API_KEY || process.env.HARNESS_API_KEY;

  if (savedKey) {
    client = new NanoClient(BASE_URL, savedKey);
    console.log('Using NANO_API_KEY');
  } else {
    client = await NanoClient.register(BASE_URL, {
      name: 'Claude Code — Local',
      type: 'claude-code',
      metadata: { version: '1.0', capabilities: ['code', 'file_ops', 'git', 'bash'] },
    });
    console.log('\n✅ Registered. Save this key and re-run:\n');
    console.log(`export NANO_API_KEY=${client.apiKey}`);
    if (!GITHUB_TOKEN) console.log('export GITHUB_TOKEN=ghp_...');
    console.log('npm run agent:claude\n');
    return;
  }

  const adapter = new ClaudeCodeAdapter(client);
  let pollNow = true;

  if (WAKE_PORT) {
    http
      .createServer((req, res) => {
        if (req.method === 'POST' && (req.url === '/wake' || req.url === '/')) {
          pollNow = true;
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
          return;
        }
        res.writeHead(404);
        res.end();
      })
      .listen(WAKE_PORT, () => console.log(`⚡ Wake server on :${WAKE_PORT} (set RUNNER_WAKE_URL to reach this)`));
  }

  console.log('👀 Polling for local tasks (runner=local). Create one from the Nano app.\n');

  while (true) {
    try {
      await client.heartbeat().catch(() => {});
      const { tasks } = await client.request('/api/tasks?status=pending&runner=local');
      if (tasks.length > 0) {
        console.log(`\n📋 Task: ${tasks[0].description}`);
        await adapter.runTask(tasks[0]);
        console.log('✅ Done\n');
      }
    } catch (err) {
      console.error('Error:', err.message);
    }
    if (pollNow) {
      pollNow = false;
    } else {
      await sleep(POLL_MS);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
