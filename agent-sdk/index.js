/**
 * Nano Agent SDK — universal client for any coding agent.
 * Works with mock agents, Claude Code adapters, Codex adapters, etc.
 */

export class NanoClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async request(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...options.headers,
    };
    const res = await fetch(`${this.baseUrl}${path}`, { ...options, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  static async register(baseUrl, { name, type, metadata }) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, metadata }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    return new NanoClient(baseUrl, data.apiKey);
  }

  async pollTask() {
    const agent = await this.request('/api/agents');
    const self = agent.agents?.find((a) => true);
    // Get agent id from a lightweight approach - poll pending tasks
    const { tasks } = await this.request('/api/tasks?status=pending');
    return tasks[0] ?? null;
  }

  async claimTask(taskId) {
    return this.request(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'running' }),
    });
  }

  async log(taskId, message, level = 'info', metadata) {
    return this.request('/api/logs', {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId, level, message, metadata }),
    });
  }

  async requestApproval(taskId, actionType, details) {
    const { approval } = await this.request('/api/approvals', {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId, action_type: actionType, details }),
    });
    return approval;
  }

  async waitForApproval(approvalId, pollMs = 1500, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { approval } = await this.request(`/api/approvals/${approvalId}`);
      if (approval.status !== 'pending') return approval.status;
      await sleep(pollMs);
    }
    throw new Error('Approval timed out');
  }

  async completeTask(taskId, result) {
    return this.request(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed', result }),
    });
  }

  async failTask(taskId, result) {
    return this.request(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'failed', result }),
    });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default NanoClient;
