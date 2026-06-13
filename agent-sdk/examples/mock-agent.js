/**
 * Mock coding agent for Nano POC demo.
 *
 * Usage:
 *   NANO_URL=http://127.0.0.1:8787 node examples/mock-agent.js
 */

import NanoClient from '../index.js';

const BASE_URL = process.env.NANO_URL || process.env.HARNESS_URL || 'http://127.0.0.1:8787';
const POLL_MS = 2000;

async function runDemoTask(client, task) {
  console.log(`\n📋 Claimed task: ${task.description}`);

  await client.claimTask(task.id);
  await client.log(task.id, `Starting: ${task.description}`);

  const steps = [
    { msg: 'Analyzing codebase structure...', delay: 800 },
    { msg: 'Reading src/auth.ts', delay: 600, meta: { file: 'src/auth.ts', action: 'read' } },
    { msg: 'Planning OAuth2 migration', delay: 700 },
    { msg: 'Creating src/oauth.ts', delay: 900, meta: { file: 'src/oauth.ts', action: 'create' } },
    { msg: 'Updating src/auth.ts', delay: 800, meta: { file: 'src/auth.ts', action: 'edit' } },
    { msg: 'Running type checks...', delay: 600 },
  ];

  for (const step of steps) {
    await sleep(step.delay);
    await client.log(task.id, step.msg, 'info', step.meta);
    console.log(`  → ${step.msg}`);
  }

  await client.log(task.id, 'Requesting approval to delete deprecated files', 'warning');
  console.log('  ⚠️  Requesting approval...');

  const approval = await client.requestApproval(task.id, 'file_delete', {
    files: ['old_auth.ts', 'deprecated_config.json'],
    reason: 'No longer needed after OAuth2 migration',
  });

  const decision = await client.waitForApproval(approval.id);
  console.log(`  ${decision === 'approved' ? '✅' : '❌'} Approval: ${decision}`);

  if (decision !== 'approved') {
    await client.failTask(task.id, { summary: 'Rejected by user', filesModified: 2 });
    return;
  }

  await client.log(task.id, 'Deleting old_auth.ts', 'info', { file: 'old_auth.ts', action: 'delete' });
  await client.log(task.id, 'Deleting deprecated_config.json', 'info', { file: 'deprecated_config.json', action: 'delete' });
  await sleep(500);
  await client.log(task.id, 'OAuth2 migration complete', 'info');

  await client.completeTask(task.id, {
    filesModified: ['src/auth.ts'],
    filesCreated: ['src/oauth.ts', 'src/oauth-config.ts'],
    filesDeleted: ['old_auth.ts', 'deprecated_config.json'],
    summary: 'Successfully migrated authentication to OAuth2',
  });

  console.log('  ✅ Task completed\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`🔗 Connecting to Nano at ${BASE_URL}`);

  let client;
  const savedKey = process.env.NANO_API_KEY || process.env.HARNESS_API_KEY;

  if (savedKey) {
    client = new NanoClient(BASE_URL, savedKey);
    console.log('Using existing API key from NANO_API_KEY');
  } else {
    client = await NanoClient.register(BASE_URL, {
      name: 'Mock Agent — Demo',
      type: 'mock',
      metadata: { version: '0.1.0', capabilities: ['code', 'file_ops', 'git'] },
    });
    console.log(`Registered agent. Save this key: ${client.apiKey}`);
  }

  console.log('👀 Polling for tasks... (assign one from the mobile UI)');

  while (true) {
    try {
      const { tasks } = await client.request('/api/tasks?status=pending');
      if (tasks.length > 0) {
        await runDemoTask(client, tasks[0]);
      }
    } catch (err) {
      console.error('Error:', err.message);
    }
    await sleep(POLL_MS);
  }
}

main();
