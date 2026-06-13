import { Hono } from 'hono';
import { createAgent, getAgent, listAgents, toAgentPublic, updateAgentLastActive, updateAgentStatus } from '../db/queries';
import { requireAgentAuth } from '../middleware/auth';
import type { Agent, Env } from '../types';
import { broadcast } from '../ws';

export const agentsApi = new Hono<{ Bindings: Env; Variables: { agent: Agent } }>();

agentsApi.post('/heartbeat', requireAgentAuth, async (c) => {
  const agent = c.get('agent');
  await updateAgentLastActive(c.env.DB, agent.id);
  const updated = await getAgent(c.env.DB, agent.id);
  return c.json({
    ok: true,
    agent: updated ? toAgentPublic(updated) : null,
  });
});

agentsApi.get('/', async (c) => {
  const agents = await listAgents(c.env.DB);
  return c.json({ agents });
});

agentsApi.post('/', async (c) => {
  const body = await c.req.json<{ name: string; type: string; metadata?: Record<string, unknown> }>();
  if (!body.name || !body.type) {
    return c.json({ error: 'name and type are required' }, 400);
  }
  const { agent, apiKey } = await createAgent(c.env.DB, body);
  await broadcast(c.env, { type: 'agent_status', agentId: agent.id, status: 'idle' });
  return c.json({ agent, apiKey }, 201);
});

agentsApi.get('/:id', async (c) => {
  const agent = await getAgent(c.env.DB, c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ agent: toAgentPublic(agent) });
});

agentsApi.patch('/:id', async (c) => {
  const body = await c.req.json<{ status?: string }>();
  const agent = await getAgent(c.env.DB, c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  if (body.status) {
    await updateAgentStatus(c.env.DB, agent.id, body.status);
    await broadcast(c.env, {
      type: 'agent_status',
      agentId: agent.id,
      status: body.status as 'idle' | 'running' | 'paused' | 'error',
    });
  }
  const updated = await getAgent(c.env.DB, agent.id);
  return c.json({ agent: updated ? toAgentPublic(updated) : null });
});
