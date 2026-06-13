import { Hono } from 'hono';
import { createLog, listLogs, updateAgentStatus } from '../db/queries';
import { requireAgentAuth } from '../middleware/auth';
import type { Agent, Env, LogLevel } from '../types';
import { broadcast } from '../ws';

export const logsApi = new Hono<{ Bindings: Env; Variables: { agent: Agent } }>();

logsApi.get('/', async (c) => {
  const agent_id = c.req.query('agent_id');
  const task_id = c.req.query('task_id');
  const limit = c.req.query('limit');
  const logs = await listLogs(c.env.DB, {
    agent_id: agent_id ?? undefined,
    task_id: task_id ?? undefined,
    limit: limit ? Number(limit) : undefined,
  });
  return c.json({ logs });
});

logsApi.post('/', requireAgentAuth, async (c) => {
  const agent = c.get('agent');
  const body = await c.req.json<{
    task_id?: string;
    level: LogLevel;
    message: string;
    metadata?: Record<string, unknown>;
  }>();

  if (!body.message || !body.level) {
    return c.json({ error: 'message and level are required' }, 400);
  }

  const log = await createLog(c.env.DB, {
    agent_id: agent.id,
    task_id: body.task_id,
    level: body.level,
    message: body.message,
    metadata: body.metadata,
  });

  await updateAgentStatus(c.env.DB, agent.id, 'running');
  await broadcast(c.env, {
    type: 'log',
    agentId: agent.id,
    taskId: log.task_id,
    level: log.level,
    message: log.message,
    timestamp: log.timestamp,
  });

  return c.json({ log }, 201);
});
