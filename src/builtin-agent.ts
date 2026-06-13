import {
  createApproval,
  createLog,
  getApproval,
  listAgents,
  createAgent,
  updateAgentStatus,
  updateTask,
  getTask,
} from './db/queries';
import {
  commitFile,
  createBranch,
  fetchReadmeSnippet,
  fetchRepo,
  getBranchSha,
  listRepoContents,
  type GitHubRepo,
} from './lib/github';
import type { Env, Task } from './types';
import { broadcast } from './ws';

const BUILTIN_AGENT_NAME = 'Nano Cloud Agent';
const BUILTIN_TYPE = 'cloud';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function emitLog(
  env: Env,
  agentId: string,
  taskId: string,
  message: string,
  level: 'info' | 'warning' | 'error' | 'debug' = 'info',
  metadata?: Record<string, unknown>
) {
  const log = await createLog(env.DB, { agent_id: agentId, task_id: taskId, level, message, metadata });
  await broadcast(env, {
    type: 'log',
    agentId,
    taskId,
    level,
    message,
    timestamp: log.timestamp,
  });
}

function fallbackPlan(task: Task, repo: GitHubRepo, files: string[]): string {
  return `# Nano Task Plan

**Repo:** ${repo.full_name}
**Task:** ${task.description}

## Repository context
- Language: ${repo.language ?? 'unknown'}
- Default branch: ${repo.default_branch}
- Top-level: ${files.slice(0, 12).join(', ') || 'n/a'}

## Proposed steps
1. Inspect affected modules and existing patterns
2. Implement: ${task.description}
3. Run project tests / lint
4. Open PR for review
`;
}

async function generateTaskPlan(
  env: Env,
  task: Task,
  repo: GitHubRepo,
  files: string[],
  readme?: string
): Promise<string> {
  const prompt = `Write a concise engineering plan in markdown for this coding task.

Repo: ${repo.full_name}
Language: ${repo.language ?? 'unknown'}
Task: ${task.description}
Top-level paths: ${files.slice(0, 20).join(', ')}
${readme ? `README excerpt:\n${readme.slice(0, 600)}` : ''}

Include: brief summary, files/areas to change, numbered implementation steps, and risks. Under 80 lines.`;

  try {
    const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        { role: 'system', content: 'You write clear, actionable engineering task plans in markdown only.' },
        { role: 'user', content: prompt },
      ],
    });
    const text =
      typeof response === 'object' && response !== null && 'response' in response
        ? String((response as { response: string }).response)
        : String(response);
    const trimmed = text.trim();
    return trimmed.length > 80 ? trimmed : fallbackPlan(task, repo, files);
  } catch {
    return fallbackPlan(task, repo, files);
  }
}

export async function ensureBuiltinAgent(env: Env): Promise<{ id: string; apiKey: string }> {
  const agents = await listAgents(env.DB);
  const existing = agents.find((a) => a.type === BUILTIN_TYPE);
  if (existing) {
    const full = await env.DB.prepare('SELECT api_key FROM agents WHERE id = ?')
      .bind(existing.id)
      .first<{ api_key: string }>();
    return { id: existing.id, apiKey: full?.api_key ?? '' };
  }
  const { agent, apiKey } = await createAgent(env.DB, {
    name: BUILTIN_AGENT_NAME,
    type: BUILTIN_TYPE,
    metadata: { builtin: true, capabilities: ['github', 'analysis', 'approval', 'branch', 'commit'] },
  });
  return { id: agent.id, apiKey };
}

async function waitForApproval(env: Env, approvalId: string, timeoutMs = 300000): Promise<'approved' | 'rejected' | 'timeout'> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const approval = await getApproval(env.DB, approvalId);
    if (!approval) return 'timeout';
    if (approval.status === 'approved') return 'approved';
    if (approval.status === 'rejected') return 'rejected';
    await sleep(2000);
  }
  return 'timeout';
}

export async function runBuiltinTask(env: Env, taskId: string, githubToken?: string): Promise<void> {
  const task = await getTask(env.DB, taskId);
  if (!task || task.status !== 'pending') return;
  if (!task.github_owner || !task.github_repo) return;

  const { id: agentId } = await ensureBuiltinAgent(env);
  const now = Date.now();

  await updateTask(env.DB, taskId, {
    status: 'running',
    agent_id: agentId,
    started_at: now,
  });
  await updateAgentStatus(env.DB, agentId, 'running');
  await broadcast(env, {
    type: 'agent_status',
    agentId,
    status: 'running',
    currentTask: task.description,
  });

  let repo: GitHubRepo;
  try {
    await emitLog(env, agentId, taskId, `Connecting to GitHub: ${task.github_owner}/${task.github_repo}`);
    repo = await fetchRepo(task.github_owner, task.github_repo, githubToken);
    const writeLabel = repo.permissions?.push ? 'write access' : 'read-only';
    await emitLog(env, agentId, taskId, `Repository found: ${repo.full_name} (${writeLabel})`, 'info', {
      stars: repo.stargazers_count,
      language: repo.language,
      branch: repo.default_branch,
      canWrite: !!repo.permissions?.push,
    });
  } catch (err) {
    const msg = (err as Error).message;
    const hint = msg.includes('rate limit')
      ? `${msg} — Add GITHUB_TOKEN to .dev.vars (see .dev.vars.example)`
      : msg;
    await emitLog(env, agentId, taskId, `GitHub error: ${hint}`, 'error');
    await updateTask(env.DB, taskId, { status: 'failed', completed_at: Date.now() });
    await updateAgentStatus(env.DB, agentId, 'idle');
    return;
  }

  const branch = task.github_branch || repo.default_branch;
  const canWrite = !!(githubToken && repo.permissions?.push);
  await emitLog(env, agentId, taskId, `Using branch: ${branch}`);
  await emitLog(
    env,
    agentId,
    taskId,
    `Repo stats — ★ ${repo.stargazers_count.toLocaleString()} · ${repo.language ?? 'Unknown'} · ${repo.open_issues_count} issues`
  );

  const files = await listRepoContents(repo.owner, repo.repo, branch, githubToken);
  if (files.length) {
    await emitLog(env, agentId, taskId, `Top-level: ${files.slice(0, 12).join(', ')}${files.length > 12 ? '…' : ''}`);
  }

  const readme = await fetchReadmeSnippet(repo.owner, repo.repo, githubToken);
  if (readme) {
    const preview = readme.split('\n').slice(0, 3).join(' ').slice(0, 120);
    await emitLog(env, agentId, taskId, `README: ${preview}…`, 'debug');
  }

  await emitLog(env, agentId, taskId, `Analyzing task: "${task.description}"`);
  await sleep(400);

  const proposedBranch = `nano/${taskId.slice(0, 8)}`;
  const targetFiles = files.filter((f) =>
    /^(src|lib|app|packages|server|client)/i.test(f) || /\.(ts|js|py|go|rs)$/i.test(f)
  ).slice(0, 5);

  await emitLog(
    env,
    agentId,
    taskId,
    targetFiles.length
      ? `Identified scope: ${targetFiles.join(', ')}`
      : 'Scanning repository structure for changes'
  );

  const approvalAction = canWrite
    ? `Create branch "${proposedBranch}" and commit NANO-TASK.md plan`
    : `Analyze "${repo.full_name}" (read-only — pick a repo you own to create branches)`;

  await updateTask(env.DB, taskId, { status: 'waiting_approval' });
  const approval = await createApproval(env.DB, {
    agent_id: agentId,
    task_id: taskId,
    action_type: canWrite ? 'git_branch_push' : 'repo_analysis',
    details: {
      repo: repo.full_name,
      url: repo.html_url,
      action: approvalAction,
      task: task.description,
      affectedPaths: targetFiles.length ? targetFiles : files.slice(0, 5),
      branch: proposedBranch,
      baseBranch: branch,
      canWrite,
    },
  });

  await broadcast(env, {
    type: 'approval_required',
    approvalId: approval.id,
    agentId,
    actionType: approval.action_type,
    details: JSON.parse(approval.details),
  });

  await emitLog(env, agentId, taskId, 'Waiting for your approval on mobile…', 'warning');

  const decision = await waitForApproval(env, approval.id);

  if (decision === 'rejected') {
    await emitLog(env, agentId, taskId, 'Changes rejected by user', 'error');
    await updateTask(env.DB, taskId, {
      status: 'failed',
      completed_at: Date.now(),
      result: JSON.stringify({ summary: 'Rejected by user', repo: repo.full_name }),
    });
    await updateAgentStatus(env.DB, agentId, 'idle');
    await broadcast(env, { type: 'agent_status', agentId, status: 'idle' });
    return;
  }

  if (decision === 'timeout') {
    await emitLog(env, agentId, taskId, 'Approval timed out', 'error');
    await updateTask(env.DB, taskId, { status: 'failed', completed_at: Date.now() });
    await updateAgentStatus(env.DB, agentId, 'idle');
    return;
  }

  await updateTask(env.DB, taskId, { status: 'running' });
  await emitLog(env, agentId, taskId, 'Approved — generating plan with Workers AI…', 'info');

  const plan = await generateTaskPlan(env, task, repo, files, readme);
  await emitLog(env, agentId, taskId, 'Task plan generated', 'info');

  if (!canWrite || !githubToken) {
    await emitLog(
      env,
      agentId,
      taskId,
      'Read-only repo — analysis complete. Select a repo you own (with push access) to create branches.',
      'warning'
    );
    const result = {
      summary: `Analyzed ${repo.full_name}: ${task.description}`,
      repo: repo.full_name,
      url: repo.html_url,
      language: repo.language,
      analysisOnly: true,
      planPreview: plan.slice(0, 300),
      note: 'No write access. Use your own repo to enable branch + commit.',
    };
    const completed = await updateTask(env.DB, taskId, {
      status: 'completed',
      completed_at: Date.now(),
      result: JSON.stringify(result),
    });
    await updateAgentStatus(env.DB, agentId, 'idle');
    await broadcast(env, { type: 'agent_status', agentId, status: 'idle' });
    if (completed) {
      await broadcast(env, { type: 'task_updated', task: completed });
      await broadcast(env, { type: 'task_completed', taskId, agentId, result });
    }
    return;
  }

  try {
    await emitLog(env, agentId, taskId, `Creating branch ${proposedBranch} from ${branch}…`);
    const baseSha = await getBranchSha(repo.owner, repo.repo, branch, githubToken);
    const branchUrl = await createBranch(repo.owner, repo.repo, proposedBranch, baseSha, githubToken);
    await emitLog(env, agentId, taskId, `Branch ready: ${proposedBranch}`, 'info', { branchUrl });

    await emitLog(env, agentId, taskId, 'Committing NANO-TASK.md…');
    const commitUrl = await commitFile(
      repo.owner,
      repo.repo,
      'NANO-TASK.md',
      plan,
      proposedBranch,
      `nano: add task plan — ${task.description.slice(0, 72)}`,
      githubToken
    );
    await emitLog(env, agentId, taskId, 'Commit pushed to GitHub', 'info', { commitUrl, branchUrl });

    const result = {
      summary: `Created ${proposedBranch} on ${repo.full_name} with implementation plan`,
      repo: repo.full_name,
      url: repo.html_url,
      language: repo.language,
      branch: proposedBranch,
      branchUrl,
      commitUrl,
      filesScanned: files.length,
      planPreview: plan.slice(0, 200),
    };

    const completed = await updateTask(env.DB, taskId, {
      status: 'completed',
      completed_at: Date.now(),
      result: JSON.stringify(result),
    });

    await updateAgentStatus(env.DB, agentId, 'idle');
    await broadcast(env, { type: 'agent_status', agentId, status: 'idle' });
    if (completed) {
      await broadcast(env, { type: 'task_updated', task: completed });
      await broadcast(env, { type: 'task_completed', taskId, agentId, result });
    }
  } catch (err) {
    const msg = (err as Error).message;
    await emitLog(env, agentId, taskId, `GitHub write failed: ${msg}`, 'error');
    await updateTask(env.DB, taskId, {
      status: 'failed',
      completed_at: Date.now(),
      result: JSON.stringify({ summary: `Write failed: ${msg}`, repo: repo.full_name }),
    });
    await updateAgentStatus(env.DB, agentId, 'idle');
    await broadcast(env, { type: 'agent_status', agentId, status: 'idle' });
  }
}

export async function processPendingTasks(env: Env, githubToken?: string): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM tasks WHERE status = 'pending' AND github_owner IS NOT NULL ORDER BY created_at ASC LIMIT 1"
  ).all<{ id: string }>();

  const task = results?.[0];
  if (!task) return 0;

  await runBuiltinTask(env, task.id, githubToken);
  return 1;
}
