import { Hono } from 'hono';
import { ensureBuiltinAgent, processPendingTasks } from '../builtin-agent';
import type { Env } from '../types';

export const runnerApi = new Hono<{ Bindings: Env & { GITHUB_TOKEN?: string } }>();

runnerApi.post('/ensure-agent', async (c) => {
  const agent = await ensureBuiltinAgent(c.env);
  return c.json({ agent: { id: agent.id, name: 'Nano Cloud Agent', type: 'cloud' } });
});

runnerApi.post('/process', async (c) => {
  const processed = await processPendingTasks(c.env, c.env.GITHUB_TOKEN);
  return c.json({ processed });
});
