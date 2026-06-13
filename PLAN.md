# Nano — Mobile-First Coding Agent Control Center

**Project:** Nano (repo: `nano`)  
**Event:** Cloudflare IRL Hackathon (4-hour build)  
**Goal:** Mobile-first interface to monitor, control, and orchestrate AI coding agents running in the cloud.

---

## Executive Summary

**What:** A Progressive Web App + Cloudflare backend that lets developers assign tasks to coding agents, watch real-time logs, and approve destructive actions from their phone.

**Why:** Long-running agent tasks need oversight. Developers leave their desk but still need visibility and veto power over risky operations (file deletes, git push, shell commands).

**Demo hook:** *"I assign a refactor from my phone. Logs stream live. The agent asks to delete files — I approve from the train. Task completes before I reach the office."*

---

## Multi-Agent Strategy (Claude Code, Codex, Custom)

### Verdict for POC

| Agent | POC feasibility | Integration path |
|-------|-----------------|------------------|
| **Custom harness agent** | ✅ Primary demo path | Built-in mock agent + SDK |
| **Claude Code** | ⚠️ Partial | No native remote-control API. Use a **sidecar adapter** that wraps `claude` CLI or hooks into session events and POSTs to Harness REST API |
| **Codex (OpenAI)** | ⚠️ Partial | Same pattern — thin Node adapter around Codex CLI that reports logs/approvals |
| **Cursor / OpenClaw** | ⚠️ Partial | MCP or hook-based adapter (post-hackathon) |

### Design principle: Agent-agnostic protocol

Harness does **not** embed Claude Code or Codex. It exposes a **universal REST + WebSocket protocol**. Any agent integrates by:

1. `POST /api/agents` — register and receive `apiKey`
2. Poll `GET /api/tasks?status=pending` or receive push via WebSocket
3. `POST /api/logs` — stream progress
4. `POST /api/approvals` → poll until `approved` | `rejected`
5. `PUT /api/tasks/:id` — mark complete

For the 4-hour POC:

- **Ship:** Custom mock agent using the SDK (guaranteed demo)
- **Stretch:** `agent-sdk/examples/claude-code-adapter.js` stub showing where hooks would go
- **Post-hackathon:** Official adapters per agent

This is the correct architecture — Harness is the control plane, agents are plugins.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Mobile PWA (Cloudflare Pages / Worker static assets)       │
│  Dashboard · Task assign · Live logs · Approval queue     │
└──────────────────────────┬──────────────────────────────────┘
                           │ REST + WebSocket
┌──────────────────────────▼──────────────────────────────────┐
│  Cloudflare Worker (Hono)                                   │
│  /api/* REST    /ws WebSocket upgrade                       │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Durable Object: AgentSession                               │
│  Per-agent WebSocket fan-out · ephemeral session state      │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  D1 Database                                                │
│  agents · tasks · logs · approvals                          │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Workers AI (optional POC)                                  │
│  /api/ai/parse-task · /api/ai/summarize-logs                │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Agent SDK (Node.js) — runs on dev machine / CI             │
│  Mock agent (POC) · Claude adapter (stretch)                │
└─────────────────────────────────────────────────────────────┘
```

### Cloudflare products used (demo talking points)

| Product | Usage |
|---------|-------|
| **Workers** | API + static asset serving |
| **Durable Objects** | WebSocket hub per agent session |
| **D1** | Persistent agents, tasks, logs, approvals |
| **Workers AI** | NL task parsing, log summarization |
| **WebSockets** | Real-time mobile updates |

---

## Technology Decisions (locked for build agent)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript (strict) | Type safety on Workers |
| HTTP framework | Hono | Lightweight, Workers-native |
| Frontend | Vanilla HTML/CSS/JS | Fastest 4h path, no build step |
| Styling | Custom mobile-first CSS | No Tailwind build pipeline |
| IDs | `crypto.randomUUID()` | Simple, no deps |
| Auth (POC) | API key per agent in `Authorization: Bearer` | Skip user auth for hackathon |
| Deploy | `wrangler dev` local + `wrangler deploy` | Single Worker serves API + static |

---

## Database Schema (D1)

```sql
-- agents
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,           -- 'mock' | 'claude-code' | 'codex' | 'custom'
  status TEXT NOT NULL DEFAULT 'idle',
  api_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL,
  metadata TEXT                 -- JSON
);

-- tasks
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT DEFAULT 'normal',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  result TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- logs
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- approvals
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_agent ON tasks(agent_id);
CREATE INDEX idx_logs_agent ON logs(agent_id);
CREATE INDEX idx_logs_ts ON logs(timestamp);
CREATE INDEX idx_approvals_status ON approvals(status);
```

---

## API Specification

### REST

```
GET    /api/agents
POST   /api/agents
GET    /api/agents/:id
PATCH  /api/agents/:id

GET    /api/tasks?agent_id=&status=
POST   /api/tasks
GET    /api/tasks/:id
PATCH  /api/tasks/:id
POST   /api/tasks/:id/cancel

GET    /api/logs?agent_id=&task_id=&limit=
POST   /api/logs                    [agent auth]

GET    /api/approvals?status=pending
POST   /api/approvals               [agent auth]
GET    /api/approvals/:id
POST   /api/approvals/:id/approve
POST   /api/approvals/:id/reject

POST   /api/ai/parse-task
POST   /api/ai/summarize-logs
```

### WebSocket (`GET /ws`)

**Client → Server:**
```json
{ "type": "subscribe", "agentId": "all" | "<uuid>" }
{ "type": "ping" }
```

**Server → Client:**
```json
{ "type": "agent_status", "agentId", "status", "currentTask" }
{ "type": "log", "agentId", "taskId", "level", "message", "timestamp" }
{ "type": "approval_required", "approvalId", "agentId", "actionType", "details" }
{ "type": "approval_resolved", "approvalId", "status" }
{ "type": "task_updated", "task" }
{ "type": "task_completed", "taskId", "agentId", "result" }
```

### Agent auth

Agents send `Authorization: Bearer <api_key>` on mutating endpoints (`POST /api/logs`, `POST /api/approvals`, `PATCH /api/tasks/:id`).

---

## File Structure

```
chotu/
├── PLAN.md
├── README.md
├── wrangler.toml
├── package.json
├── tsconfig.json
├── schema.sql
├── src/
│   ├── index.ts              # Worker entry, Hono app, /ws upgrade
│   ├── agent-session.ts      # Durable Object
│   ├── types.ts
│   ├── db/
│   │   └── queries.ts
│   ├── api/
│   │   ├── agents.ts
│   │   ├── tasks.ts
│   │   ├── logs.ts
│   │   ├── approvals.ts
│   │   └── ai.ts
│   └── middleware/
│       └── auth.ts
├── public/
│   ├── index.html
│   ├── manifest.json
│   ├── styles/main.css
│   └── js/
│       ├── app.js
│       ├── api.js
│       ├── websocket.js
│       └── components/
│           ├── dashboard.js
│           ├── agent-detail.js
│           ├── task-form.js
│           ├── log-viewer.js
│           └── approval-queue.js
└── agent-sdk/
    ├── package.json
    ├── index.js
    └── examples/
        ├── mock-agent.js
        └── claude-code-adapter.js
```

---

## Implementation Phases

### Phase 1 — Backend foundation (60 min)

- [ ] `npm create cloudflare` scaffold
- [ ] D1 schema + migrations
- [ ] Hono routes: agents, tasks, logs, approvals
- [ ] Durable Object WebSocket broadcast
- [ ] Agent API key middleware
- [ ] `wrangler dev` smoke test with curl

### Phase 2 — Mobile UI (60 min)

- [ ] PWA manifest + mobile viewport
- [ ] Dashboard: agent cards, stats
- [ ] Agent detail: logs + task list
- [ ] Task creation form
- [ ] Approval queue with approve/reject
- [ ] Bottom nav: Dashboard · Tasks · Approvals · Logs

### Phase 3 — Real-time + AI (60 min)

- [ ] WebSocket client with reconnect
- [ ] Live log tail with auto-scroll
- [ ] Approval push to UI
- [ ] Workers AI parse-task + summarize-logs (graceful fallback if AI unavailable)

### Phase 4 — Agent SDK + demo (60 min)

- [ ] `HarnessClient` SDK class
- [ ] `mock-agent.js` full demo loop
- [ ] Seed script for demo data
- [ ] README with demo script
- [ ] Deploy

---

## Demo Script (2 minutes)

| Time | Action |
|------|--------|
| 0:00–0:20 | Problem: can't monitor agents away from desk |
| 0:20–0:40 | Open phone PWA — show agent dashboard |
| 0:40–1:00 | Create task: "Refactor auth module to OAuth2" |
| 1:00–1:30 | Mock agent runs — logs stream on phone |
| 1:30–1:45 | Approval popup: delete 2 files — tap Approve |
| 1:45–2:00 | Task completes. Mention Cloudflare stack + open protocol |

---

## Success Criteria

1. PWA loads on mobile, feels native
2. Create task from phone UI
3. Logs appear < 1s via WebSocket
4. Approval flow end-to-end
5. Mock agent connected and working
6. 4+ Cloudflare products mentioned in README
7. Public GitHub repo with README

---

## Stretch Goals

- Push notifications (Web Push)
- Claude Code adapter with real CLI hooks
- Voice task input
- Agent analytics dashboard
- Cloudflare Access for multi-user

---

## Commands Reference

```bash
# Setup
npm install
wrangler d1 create harness-db
wrangler d1 execute harness-db --local --file=schema.sql
wrangler d1 execute harness-db --file=schema.sql

# Dev
npm run dev

# Demo agent (separate terminal)
cd agent-sdk && node examples/mock-agent.js

# Deploy
npm run deploy
```

---

## Handoff Notes for Coding Agent

1. **Do not** try to fork/embed Claude Code — build the protocol + mock agent first.
2. **Do** keep all Cloudflare bindings in `wrangler.toml`.
3. **Do** serve `public/` from the Worker via `assets` binding or static middleware.
4. **Do** test approval flow before polishing UI.
5. **Do** use Durable Object `AgentSession` id = `"global"` for POC (single broadcast hub) — simplify before per-agent DOs.
6. Workers AI calls should fail gracefully with passthrough if model unavailable.
