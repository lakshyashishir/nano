import { Hono } from 'hono';
import type { Env } from '../types';

export const aiApi = new Hono<{ Bindings: Env }>();

aiApi.post('/parse-task', async (c) => {
  const body = await c.req.json<{ description: string }>();
  if (!body.description?.trim()) {
    return c.json({ error: 'description is required' }, 400);
  }

  try {
    const response = await c.env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        {
          role: 'system',
          content:
            'Parse the coding task into JSON with keys: title (short), steps (string array), priority (low|normal|high), estimatedMinutes (number). Reply ONLY with valid JSON.',
        },
        { role: 'user', content: body.description },
      ],
    });

    const text =
      typeof response === 'object' && response !== null && 'response' in response
        ? String((response as { response: string }).response)
        : String(response);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    return c.json({ parsed, raw: text });
  } catch {
    return c.json({
      parsed: {
        title: body.description.slice(0, 60),
        steps: [body.description],
        priority: 'normal',
        estimatedMinutes: 15,
      },
      fallback: true,
    });
  }
});

aiApi.post('/summarize-logs', async (c) => {
  const body = await c.req.json<{ logs: Array<{ level: string; message: string }> }>();
  if (!body.logs?.length) {
    return c.json({ summary: 'No logs to summarize.' });
  }

  const logText = body.logs
    .slice(-20)
    .map((l) => `[${l.level}] ${l.message}`)
    .join('\n');

  try {
    const response = await c.env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'Summarize these agent logs in 2-3 sentences for a mobile user. Be concise.',
        },
        { role: 'user', content: logText },
      ],
    });

    const summary =
      typeof response === 'object' && response !== null && 'response' in response
        ? String((response as { response: string }).response)
        : String(response);

    return c.json({ summary: summary.trim() });
  } catch {
    const last = body.logs[body.logs.length - 1];
    return c.json({
      summary: `Latest: ${last.message}`,
      fallback: true,
    });
  }
});
