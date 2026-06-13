import { Hono } from 'hono';
import {
  createTask,
  getTask,
  listTasks,
  updateAgentStatus,
  updateTask,
} from '../db/queries';
import { requireAgentAuth } from '../middleware/auth';
import { runBuiltinTask } from '../builtin-agent';
import type { Agent, Env } from '../types';
import { broadcast } from '../ws';

export const tasksApi = new Hono<{ Bindings: Env; Variables: { agent: Agent } }>();

tasksApi.get('/', async (c) => {
  const agent_id = c.req.query('agent_id');
  const status = c.req.query('status');
  const tasks = await listTasks(c.env.DB, { agent_id, status });
  return c.json({ tasks });
});

tasksApi.post('/', async (c) => {
  const body = await c.req.json<{
    description: string;
    agent_id?: string;
    priority?: string;
    github_owner?: string;
    github_repo?: string;
    github_branch?: string;
    github_url?: string;
  }>();
  if (!body.description?.trim()) {
    return c.json({ error: 'description is required' }, 400);
  }
  if (!body.github_owner || !body.github_repo) {
    return c.json({ error: 'github_owner and github_repo are required' }, 400);
  }

  const task = await createTask(c.env.DB, body);
  await broadcast(c.env, { type: 'task_updated', task });

  // Auto-run built-in cloud agent (real GitHub fetch — no separate terminal needed)
  c.executionCtx.waitUntil(runBuiltinTask(c.env, task.id, c.env.GITHUB_TOKEN));

  return c.json({ task }, 201);
});

tasksApi.get('/:id', async (c) => {
  const task = await getTask(c.env.DB, c.req.param('id'));
  if (!task) return c.json({ error: 'Task not found' }, 404);
  return c.json({ task });
});

tasksApi.patch('/:id', requireAgentAuth, async (c) => {
  const agent = c.get('agent');
  const taskId = c.req.param('id');
  const body = await c.req.json<{
    status?: string;
    result?: Record<string, unknown>;
  }>();
  const existing = await getTask(c.env.DB, taskId!);
  if (!existing) return c.json({ error: 'Task not found' }, 404);

  const now = Date.now();
  const updates: Parameters<typeof updateTask>[2] = {
    agent_id: agent.id,
  };

  if (body.status) {
    updates.status = body.status as typeof existing.status;
    if (body.status === 'running' && !existing.started_at) {
      updates.started_at = now;
      await updateAgentStatus(c.env.DB, agent.id, 'running');
      await broadcast(c.env, {
        type: 'agent_status',
        agentId: agent.id,
        status: 'running',
        currentTask: existing.description,
      });
    }
    if (body.status === 'completed' || body.status === 'failed') {
      updates.completed_at = now;
      await updateAgentStatus(c.env.DB, agent.id, 'idle');
      await broadcast(c.env, { type: 'agent_status', agentId: agent.id, status: 'idle' });
    }
  }

  if (body.result) {
    updates.result = JSON.stringify(body.result);
  }

  const task = await updateTask(c.env.DB, existing.id, updates);
  if (!task) return c.json({ error: 'Update failed' }, 500);

  await broadcast(c.env, { type: 'task_updated', task });

  if (task.status === 'completed' && task.result) {
    await broadcast(c.env, {
      type: 'task_completed',
      taskId: task.id,
      agentId: agent.id,
      result: JSON.parse(task.result),
    });
  }

  return c.json({ task });
});

tasksApi.post('/:id/cancel', async (c) => {
  const task = await updateTask(c.env.DB, c.req.param('id'), {
    status: 'cancelled',
    completed_at: Date.now(),
  });
  if (!task) return c.json({ error: 'Task not found' }, 404);
  await broadcast(c.env, { type: 'task_updated', task });
  return c.json({ task });
});
