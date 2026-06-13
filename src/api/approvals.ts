import { Hono } from 'hono';
import {
  createApproval,
  getApproval,
  listApprovals,
  resolveApproval,
  updateTask,
} from '../db/queries';
import { requireAgentAuth } from '../middleware/auth';
import type { Agent, Env } from '../types';
import { broadcast } from '../ws';

export const approvalsApi = new Hono<{ Bindings: Env; Variables: { agent: Agent } }>();

approvalsApi.get('/', async (c) => {
  const status = c.req.query('status') ?? undefined;
  const approvals = await listApprovals(c.env.DB, status);
  return c.json({
    approvals: approvals.map((a) => ({
      ...a,
      details: JSON.parse(a.details),
    })),
  });
});

approvalsApi.post('/', requireAgentAuth, async (c) => {
  const agent = c.get('agent');
  const body = await c.req.json<{
    task_id: string;
    action_type: string;
    details: Record<string, unknown>;
  }>();

  if (!body.task_id || !body.action_type || !body.details) {
    return c.json({ error: 'task_id, action_type, and details are required' }, 400);
  }

  const approval = await createApproval(c.env.DB, {
    agent_id: agent.id,
    task_id: body.task_id,
    action_type: body.action_type,
    details: body.details,
  });

  await updateTask(c.env.DB, body.task_id, { status: 'waiting_approval' });

  await broadcast(c.env, {
    type: 'approval_required',
    approvalId: approval.id,
    agentId: agent.id,
    actionType: approval.action_type,
    details: body.details,
  });

  return c.json({
    approval: { ...approval, details: body.details },
  }, 201);
});

approvalsApi.get('/:id', async (c) => {
  const approval = await getApproval(c.env.DB, c.req.param('id'));
  if (!approval) return c.json({ error: 'Approval not found' }, 404);
  return c.json({
    approval: { ...approval, details: JSON.parse(approval.details) },
  });
});

async function handleResolve(
  c: { env: Env; req: { param: (k: string) => string } },
  status: 'approved' | 'rejected'
) {
  const approval = await resolveApproval(c.env.DB, c.req.param('id'), status, 'mobile_user');
  if (!approval) return null;

  const details = JSON.parse(approval.details);
  await broadcast(c.env, {
    type: 'approval_resolved',
    approvalId: approval.id,
    status,
  });

  if (status === 'approved') {
    await updateTask(c.env.DB, approval.task_id, { status: 'running' });
  } else {
    await updateTask(c.env.DB, approval.task_id, { status: 'failed', completed_at: Date.now() });
  }

  return { ...approval, details };
}

approvalsApi.post('/:id/approve', async (c) => {
  const result = await handleResolve(c, 'approved');
  if (!result) return c.json({ error: 'Approval not found or already resolved' }, 404);
  return c.json({ approval: result });
});

approvalsApi.post('/:id/reject', async (c) => {
  const result = await handleResolve(c, 'rejected');
  if (!result) return c.json({ error: 'Approval not found or already resolved' }, 404);
  return c.json({ approval: result });
});
