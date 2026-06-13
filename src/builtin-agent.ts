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
  createPullRequest,
  fetchReadmeSnippet,
  fetchRepo,
  getBranchSha,
  listRepoContents,
  type GitHubRepo,
} from './lib/github';
import {
  buildTaskManifest,
  buildTaskPlan,
  parseTaskDescription,
} from './lib/task-plan';
import {
  extractReferencedRepo,
  resolveDeliverables,
} from './lib/deliverables';
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
  const refRepo = extractReferencedRepo(task.description);
  let contextReadme: string | undefined;
  if (refRepo && githubToken) {
    const [owner, name] = refRepo.split('/');
    if (owner && name) {
      contextReadme = (await fetchReadmeSnippet(owner, name, githubToken)) ?? undefined;
    }
  }
  const deliverables = resolveDeliverables(task.description, repo, {
    contextRepo: refRepo,
    contextReadme,
  });
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
    ? deliverables.length
      ? `Create branch "${proposedBranch}" and add ${deliverables.map((d) => d.path).join(', ')}`
      : `Create branch "${proposedBranch}" on ${repo.full_name}`
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
      affectedPaths: deliverables.length
        ? deliverables.map((d) => d.path)
        : targetFiles.length
          ? targetFiles
          : files.slice(0, 5),
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
  await emitLog(env, agentId, taskId, 'Approved — building task plan (local, no AI calls)…', 'info');

  const plan = buildTaskPlan(task, repo, files, readme ?? undefined);
  const parsed = parseTaskDescription(task.description);
  await emitLog(env, agentId, taskId, `Plan ready — ${parsed.priority} priority, ~${parsed.estimatedMinutes}min`, 'info');
  if (deliverables.length) {
    await emitLog(
      env,
      agentId,
      taskId,
      `Creating: ${deliverables.map((d) => d.path).join(', ')}`,
      'info'
    );
  }

  if (canWrite && !deliverables.length) {
    await emitLog(env, agentId, taskId, 'Could not infer files to create for this task', 'error');
    await updateTask(env.DB, taskId, {
      status: 'failed',
      completed_at: Date.now(),
      result: JSON.stringify({
        summary: `Could not infer files to create for: ${task.description}`,
        note: 'Try naming a file explicitly, e.g. "add hack.md and say HI" or "write a html ui"',
      }),
    });
    await updateAgentStatus(env.DB, agentId, 'idle');
    await broadcast(env, { type: 'agent_status', agentId, status: 'idle' });
    return;
  }

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

    const committedFiles: string[] = [];

    for (const file of deliverables) {
      await emitLog(env, agentId, taskId, `Writing ${file.path}…`);
      await commitFile(
        repo.owner,
        repo.repo,
        file.path,
        file.content,
        proposedBranch,
        `nano: add ${file.path}`,
        githubToken
      );
      committedFiles.push(file.path);
    }

    const manifest = buildTaskManifest(task, repo, proposedBranch, targetFiles, deliverables);
    await commitFile(
      repo.owner,
      repo.repo,
      `.nano/task-${taskId.slice(0, 8)}.json`,
      manifest,
      proposedBranch,
      `nano: task manifest`,
      githubToken
    );

    await emitLog(env, agentId, taskId, 'Commits pushed to GitHub', 'info', {
      branchUrl,
      files: committedFiles,
    });

    let prUrl: string | undefined;
    try {
      await emitLog(env, agentId, taskId, 'Opening pull request…');
      const prTitle = `nano: ${task.description.slice(0, 80)}`;
      const fileList = committedFiles.map((f) => `- \`${f}\``).join('\n');
      const prBody = `## Nano agent\n\n**Task:** ${task.description}\n\n**Files added:**\n${fileList}`;
      prUrl = await createPullRequest(
        repo.owner,
        repo.repo,
        prTitle,
        proposedBranch,
        branch,
        prBody,
        githubToken
      );
      await emitLog(env, agentId, taskId, 'Pull request created', 'info', { prUrl });
    } catch (err) {
      await emitLog(env, agentId, taskId, `PR skipped: ${(err as Error).message}`, 'warning');
    }

    const result = {
      summary: prUrl
        ? `Opened PR adding ${committedFiles.join(', ')} on ${repo.full_name}`
        : `Created ${proposedBranch} on ${repo.full_name}`,
      repo: repo.full_name,
      url: repo.html_url,
      language: repo.language,
      branch: proposedBranch,
      branchUrl,
      prUrl,
      files: committedFiles,
      filesScanned: files.length,
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
