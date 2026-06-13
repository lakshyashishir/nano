import type { Context, Next } from 'hono';
import { getAgentByApiKey } from '../db/queries';
import type { Agent, Env } from '../types';

export type AgentVariables = { agent: Agent };

export async function requireAgentAuth(c: Context<{ Bindings: Env; Variables: AgentVariables }>, next: Next) {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }
  const apiKey = header.slice(7);
  const agent = await getAgentByApiKey(c.env.DB, apiKey);
  if (!agent) {
    return c.json({ error: 'Invalid API key' }, 401);
  }
  c.set('agent', agent);
  await next();
}
