export type AgentStatus = 'idle' | 'running' | 'paused' | 'error';
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type LogLevel = 'info' | 'warning' | 'error' | 'debug';

export interface Agent {
  id: string;
  name: string;
  type: string;
  status: AgentStatus;
  api_key: string;
  created_at: number;
  last_active: number;
  metadata: string | null;
}

export interface AgentPublic {
  id: string;
  name: string;
  type: string;
  status: AgentStatus;
  created_at: number;
  last_active: number;
  metadata: Record<string, unknown> | null;
}

export interface Task {
  id: string;
  agent_id: string | null;
  description: string;
  status: TaskStatus;
  priority: string;
  github_owner: string | null;
  github_repo: string | null;
  github_branch: string | null;
  github_url: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
}

export interface LogEntry {
  id: number;
  agent_id: string;
  task_id: string | null;
  level: LogLevel;
  message: string;
  timestamp: number;
  metadata: string | null;
}

export interface Approval {
  id: string;
  agent_id: string;
  task_id: string;
  action_type: string;
  details: string;
  status: ApprovalStatus;
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

export interface Env {
  DB: D1Database;
  AGENT_SESSION: DurableObjectNamespace;
  AI: Ai;
  ASSETS: Fetcher;
  GITHUB_TOKEN?: string;
}

export type WsEvent =
  | { type: 'agent_status'; agentId: string; status: AgentStatus; currentTask?: string }
  | { type: 'log'; agentId: string; taskId: string | null; level: LogLevel; message: string; timestamp: number }
  | { type: 'approval_required'; approvalId: string; agentId: string; actionType: string; details: unknown }
  | { type: 'approval_resolved'; approvalId: string; status: ApprovalStatus }
  | { type: 'task_updated'; task: Task }
  | { type: 'task_completed'; taskId: string; agentId: string; result: unknown };
