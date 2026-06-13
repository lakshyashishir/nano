import type { Agent, AgentPublic, Approval, LogEntry, Task } from '../types';

export function toAgentPublic(agent: Agent): AgentPublic {
  return {
    id: agent.id,
    name: agent.name,
    type: agent.type,
    status: agent.status,
    created_at: agent.created_at,
    last_active: agent.last_active,
    metadata: agent.metadata ? JSON.parse(agent.metadata) : null,
  };
}

export async function listAgents(db: D1Database): Promise<AgentPublic[]> {
  const { results } = await db.prepare('SELECT * FROM agents ORDER BY last_active DESC').all<Agent>();
  return (results ?? []).map(toAgentPublic);
}

export async function getAgent(db: D1Database, id: string): Promise<Agent | null> {
  return db.prepare('SELECT * FROM agents WHERE id = ?').bind(id).first<Agent>();
}

export async function getAgentByApiKey(db: D1Database, apiKey: string): Promise<Agent | null> {
  return db.prepare('SELECT * FROM agents WHERE api_key = ?').bind(apiKey).first<Agent>();
}

export async function createAgent(
  db: D1Database,
  data: { name: string; type: string; metadata?: Record<string, unknown> }
): Promise<{ agent: AgentPublic; apiKey: string }> {
  const id = crypto.randomUUID();
  const apiKey = `nano_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO agents (id, name, type, status, api_key, created_at, last_active, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(id, data.name, data.type, 'idle', apiKey, now, now, data.metadata ? JSON.stringify(data.metadata) : null)
    .run();
  const agent = await getAgent(db, id);
  if (!agent) throw new Error('Failed to create agent');
  return { agent: toAgentPublic(agent), apiKey };
}

export async function updateAgentStatus(db: D1Database, id: string, status: string): Promise<void> {
  await db
    .prepare('UPDATE agents SET status = ?, last_active = ? WHERE id = ?')
    .bind(status, Date.now(), id)
    .run();
}

export async function listTasks(
  db: D1Database,
  filters: { agent_id?: string; status?: string }
): Promise<Task[]> {
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const binds: string[] = [];
  if (filters.agent_id) {
    query += ' AND agent_id = ?';
    binds.push(filters.agent_id);
  }
  if (filters.status) {
    query += ' AND status = ?';
    binds.push(filters.status);
  }
  query += ' ORDER BY created_at DESC LIMIT 100';
  const stmt = db.prepare(query);
  const { results } = await (binds.length ? stmt.bind(...binds) : stmt).all<Task>();
  return results ?? [];
}

export async function getTask(db: D1Database, id: string): Promise<Task | null> {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<Task>();
}

export async function createTask(
  db: D1Database,
  data: {
    description: string;
    agent_id?: string;
    priority?: string;
    github_owner?: string;
    github_repo?: string;
    github_branch?: string;
    github_url?: string;
  }
): Promise<Task> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO tasks (id, agent_id, description, status, priority, github_owner, github_repo, github_branch, github_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      data.agent_id ?? null,
      data.description,
      'pending',
      data.priority ?? 'normal',
      data.github_owner ?? null,
      data.github_repo ?? null,
      data.github_branch ?? null,
      data.github_url ?? null,
      now
    )
    .run();
  const task = await getTask(db, id);
  if (!task) throw new Error('Failed to create task');
  return task;
}

export async function updateTask(
  db: D1Database,
  id: string,
  updates: Partial<Pick<Task, 'status' | 'agent_id' | 'result'>> & {
    started_at?: number | null;
    completed_at?: number | null;
  }
): Promise<Task | null> {
  const existing = await getTask(db, id);
  if (!existing) return null;

  const task: Task = {
    ...existing,
    status: updates.status ?? existing.status,
    agent_id: updates.agent_id !== undefined ? updates.agent_id : existing.agent_id,
    result: updates.result !== undefined ? updates.result : existing.result,
    started_at: updates.started_at !== undefined ? updates.started_at : existing.started_at,
    completed_at: updates.completed_at !== undefined ? updates.completed_at : existing.completed_at,
  };

  await db
    .prepare(
      'UPDATE tasks SET status = ?, agent_id = ?, result = ?, started_at = ?, completed_at = ? WHERE id = ?'
    )
    .bind(task.status, task.agent_id, task.result, task.started_at, task.completed_at, id)
    .run();

  return task;
}

export async function listLogs(
  db: D1Database,
  filters: { agent_id?: string; task_id?: string; limit?: number }
): Promise<LogEntry[]> {
  let query = 'SELECT * FROM logs WHERE 1=1';
  const binds: (string | number)[] = [];
  if (filters.agent_id) {
    query += ' AND agent_id = ?';
    binds.push(filters.agent_id);
  }
  if (filters.task_id) {
    query += ' AND task_id = ?';
    binds.push(filters.task_id);
  }
  query += ' ORDER BY timestamp DESC LIMIT ?';
  binds.push(filters.limit ?? 200);
  const { results } = await db.prepare(query).bind(...binds).all<LogEntry>();
  return (results ?? []).reverse();
}

export async function createLog(
  db: D1Database,
  data: {
    agent_id: string;
    task_id?: string;
    level: string;
    message: string;
    metadata?: Record<string, unknown>;
  }
): Promise<LogEntry> {
  const now = Date.now();
  const result = await db
    .prepare(
      'INSERT INTO logs (agent_id, task_id, level, message, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .bind(
      data.agent_id,
      data.task_id ?? null,
      data.level,
      data.message,
      now,
      data.metadata ? JSON.stringify(data.metadata) : null
    )
    .run();
  return {
    id: Number(result.meta.last_row_id),
    agent_id: data.agent_id,
    task_id: data.task_id ?? null,
    level: data.level as LogEntry['level'],
    message: data.message,
    timestamp: now,
    metadata: data.metadata ? JSON.stringify(data.metadata) : null,
  };
}

export async function listApprovals(db: D1Database, status?: string): Promise<Approval[]> {
  let query = 'SELECT * FROM approvals';
  if (status) {
    const { results } = await db
      .prepare(`${query} WHERE status = ? ORDER BY created_at DESC`)
      .bind(status)
      .all<Approval>();
    return results ?? [];
  }
  const { results } = await db.prepare(`${query} ORDER BY created_at DESC LIMIT 50`).all<Approval>();
  return results ?? [];
}

export async function getApproval(db: D1Database, id: string): Promise<Approval | null> {
  return db.prepare('SELECT * FROM approvals WHERE id = ?').bind(id).first<Approval>();
}

export async function createApproval(
  db: D1Database,
  data: {
    agent_id: string;
    task_id: string;
    action_type: string;
    details: Record<string, unknown>;
  }
): Promise<Approval> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO approvals (id, agent_id, task_id, action_type, details, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(id, data.agent_id, data.task_id, data.action_type, JSON.stringify(data.details), 'pending', now)
    .run();
  const approval = await getApproval(db, id);
  if (!approval) throw new Error('Failed to create approval');
  return approval;
}

export async function resolveApproval(
  db: D1Database,
  id: string,
  status: 'approved' | 'rejected',
  resolvedBy: string
): Promise<Approval | null> {
  const now = Date.now();
  await db
    .prepare('UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND status = ?')
    .bind(status, now, resolvedBy, id, 'pending')
    .run();
  return getApproval(db, id);
}

export async function getDashboardStats(db: D1Database) {
  const [agents, pendingTasks, pendingApprovals, completedToday] = await Promise.all([
    db.prepare('SELECT COUNT(*) as count FROM agents').first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) as count FROM approvals WHERE status = 'pending'").first<{ count: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) as count FROM tasks WHERE status = 'completed' AND completed_at > ?"
      )
      .bind(Date.now() - 86400000)
      .first<{ count: number }>(),
  ]);
  return {
    agents: agents?.count ?? 0,
    pendingTasks: pendingTasks?.count ?? 0,
    pendingApprovals: pendingApprovals?.count ?? 0,
    completedToday: completedToday?.count ?? 0,
  };
}
