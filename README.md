# Nano

Mobile-first control center for AI coding agents. Monitor tasks, stream logs, and approve destructive actions from your phone.

Built for the **Cloudflare IRL Hackathon** using Workers, Durable Objects, D1, Workers AI, and WebSockets.

## Quick Start

```bash
npm install
npm run db:local          # init DB (run once; includes github columns migration)
cp .dev.vars.example .dev.vars   # optional: add GITHUB_TOKEN for higher API limits
npm run dev
```

Open http://127.0.0.1:8787 — **no second terminal needed**. The built-in cloud agent runs automatically when you create a task.

### What is real vs simulated?

| Real | Simulated (for POC) |
|------|---------------------|
| GitHub repo search & metadata | Actual code patches beyond plan file |
| Live file listing from repo | Claude Code / Codex execution |
| Branch creation + NANO-TASK.md commit (writable repos) | — |
| WebSocket log streaming | — |
| Approval flow | — |
| Task persistence in D1 | — |

To apply real code changes, connect the `agent-sdk` with Claude Code or Codex (see `agent-sdk/examples/`).

## Architecture

- **Workers + Hono** — REST API
- **Durable Objects** — WebSocket broadcast hub
- **D1** — agents, tasks, logs, approvals
- **Workers AI** — task parsing & log summarization
- **Agent SDK** — universal protocol for any coding agent

See [PLAN.md](./PLAN.md) for the full build plan.

## Agent Integration

Any agent can integrate via REST:

```js
import HarnessClient from './agent-sdk/index.js';

const client = await HarnessClient.register('http://127.0.0.1:8787', {
  name: 'My Agent',
  type: 'custom',
});

await client.log(taskId, 'Working on src/auth.ts');
const approval = await client.requestApproval(taskId, 'file_delete', { files: ['old.ts'] });
const status = await client.waitForApproval(approval.id);
```

### Claude Code / Codex

No native remote API exists. Use a **sidecar adapter** (see `agent-sdk/examples/claude-code-adapter.js`) that wraps CLI output and forwards to Harness. The POC uses a mock agent; adapters are the production path.

## Deploy

```bash
# Create production D1 (once)
wrangler d1 create harness-db
# Update database_id in wrangler.toml

npm run db:migrate
npm run deploy
```

## Demo Script

1. Show problem: can't monitor agents away from desk
2. Open phone PWA → agent dashboard
3. Create task from phone
4. Mock agent runs → logs stream
5. Approve file delete on phone
6. Task completes → mention Cloudflare stack

## License

MIT
