const API_BASE = '';

export async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const nanoApi = {
  bootstrap: () => api('/api/bootstrap', { method: 'POST' }),
  getStats: () => api('/api/stats'),
  getAgents: () => api('/api/agents'),
  getTasks: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return api(`/api/tasks${q ? `?${q}` : ''}`);
  },
  createTask: (data) => api('/api/tasks', { method: 'POST', body: JSON.stringify(data) }),
  getLogs: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return api(`/api/logs${q ? `?${q}` : ''}`);
  },
  getApprovals: (status) => api(`/api/approvals${status ? `?status=${status}` : ''}`),
  approve: (id) => api(`/api/approvals/${id}/approve`, { method: 'POST' }),
  reject: (id) => api(`/api/approvals/${id}/reject`, { method: 'POST' }),
  parseTask: (description) =>
    api('/api/ai/parse-task', { method: 'POST', body: JSON.stringify({ description }) }),
  summarizeLogs: (logs) =>
    api('/api/ai/summarize-logs', { method: 'POST', body: JSON.stringify({ logs }) }),
  searchRepos: (q) => api(`/api/github/search?q=${encodeURIComponent(q)}`),
  resolveRepo: (url) => api(`/api/github/resolve?url=${encodeURIComponent(url)}`),
  getSuggestions: () => api('/api/github/suggestions'),
};
