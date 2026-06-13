import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { agentsApi } from './api/agents';
import { tasksApi } from './api/tasks';
import { logsApi } from './api/logs';
import { approvalsApi } from './api/approvals';
import { githubApi } from './api/github';
import { runnerApi } from './api/runner';
import { ensureBuiltinAgent } from './builtin-agent';
import { aiApi } from './api/ai';
import { getDashboardStats } from './db/queries';
import type { Env } from './types';

export { AgentSession } from './agent-session';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

app.get('/api/health', (c) => c.json({ status: 'ok', service: 'nano' }));

app.get('/api/stats', async (c) => {
  const stats = await getDashboardStats(c.env.DB);
  return c.json({ stats });
});

app.route('/api/agents', agentsApi);
app.route('/api/tasks', tasksApi);
app.route('/api/logs', logsApi);
app.route('/api/approvals', approvalsApi);
app.route('/api/ai', aiApi);
app.route('/api/github', githubApi);
app.route('/api/runner', runnerApi);

app.post('/api/bootstrap', async (c) => {
  await ensureBuiltinAgent(c.env);
  return c.json({ ok: true });
});

app.get('/ws', async (c) => {
  const upgrade = c.req.header('Upgrade');
  if (upgrade !== 'websocket') {
    return c.text('Expected WebSocket', 426);
  }
  const id = c.env.AGENT_SESSION.idFromName('global');
  const stub = c.env.AGENT_SESSION.get(id);
  return stub.fetch(c.req.raw);
});

app.all('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
