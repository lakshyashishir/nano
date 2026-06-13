/**
 * Claude Code adapter stub — shows integration pattern for external agents.
 *
 * Claude Code has no built-in remote control API. This adapter demonstrates
 * where you would hook into session events and forward them to Harness.
 *
 * Integration options (post-POC):
 * 1. Wrap `claude` CLI stdout/stderr and POST logs to Harness
 * 2. Use Claude Code hooks (PreToolUse, PostToolUse) to intercept tool calls
 * 3. Poll Harness for tasks and inject them as prompts
 *
 * Usage (future):
 *   HARNESS_URL=... HARNESS_API_KEY=... node examples/claude-code-adapter.js
 */

import HarnessClient from '../index.js';
import { spawn } from 'node:child_process';

const BASE_URL = process.env.HARNESS_URL || 'http://127.0.0.1:8787';

export class ClaudeCodeAdapter {
  constructor(client) {
    this.client = client;
  }

  /** Forward a Claude Code tool call to Harness for approval if destructive */
  async interceptToolCall(taskId, toolName, input) {
    const destructive = ['Bash', 'Write', 'Edit'].includes(toolName);
    const isDelete = toolName === 'Bash' && /rm\s/.test(input.command || '');

    if (isDelete) {
      const approval = await this.client.requestApproval(taskId, 'command_execute', {
        command: input.command,
        reason: 'Destructive shell command requires approval',
      });
      const status = await this.client.waitForApproval(approval.id);
      return status === 'approved';
    }

    if (destructive) {
      await this.client.log(taskId, `Tool: ${toolName}`, 'debug', { input });
    }

    return true;
  }

  /** Run Claude Code with Harness logging */
  async runTask(task) {
    await this.client.claimTask(task.id);
    await this.client.log(task.id, `Claude Code starting: ${task.description}`);

    // Stub: in production, spawn `claude` CLI and pipe output to Harness
    const proc = spawn('echo', [`[stub] Would run: claude -p "${task.description}"`], {
      shell: true,
    });

    proc.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) this.client.log(task.id, line, 'info');
    });

    return new Promise((resolve) => {
      proc.on('close', async (code) => {
        if (code === 0) {
          await this.client.completeTask(task.id, { summary: 'Claude Code task finished (stub)' });
        } else {
          await this.client.failTask(task.id, { summary: `Exit code ${code}` });
        }
        resolve();
      });
    });
  }
}

async function main() {
  const apiKey = process.env.HARNESS_API_KEY;
  if (!apiKey) {
    console.log('Register a Claude Code agent first, then set HARNESS_API_KEY');
    const client = await HarnessClient.register(BASE_URL, {
      name: 'Claude Code — MacBook',
      type: 'claude-code',
      metadata: { version: '1.0', capabilities: ['code', 'file_ops', 'git', 'bash'] },
    });
    console.log(`API Key: ${client.apiKey}`);
    return;
  }

  const client = new HarnessClient(BASE_URL, apiKey);
  const adapter = new ClaudeCodeAdapter(client);
  console.log('Claude Code adapter ready (stub). Poll Harness for tasks in your main loop.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
