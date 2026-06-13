import { Hono } from 'hono';
import { parseTaskDescription, summarizeLogs } from '../lib/task-plan';
import type { Env } from '../types';

export const aiApi = new Hono<{ Bindings: Env }>();

/** Local task parsing — no Workers AI / no external LLM calls */
aiApi.post('/parse-task', async (c) => {
  const body = await c.req.json<{ description: string }>();
  if (!body.description?.trim()) {
    return c.json({ error: 'description is required' }, 400);
  }
  return c.json({ parsed: parseTaskDescription(body.description), local: true });
});

aiApi.post('/summarize-logs', async (c) => {
  const body = await c.req.json<{ logs: Array<{ level: string; message: string }> }>();
  return c.json({ summary: summarizeLogs(body.logs ?? []), local: true });
});
