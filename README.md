# Nano

Mobile-first control center for AI coding agents. Monitor tasks, stream logs, and approve destructive actions from your phone.

Built for the **Cloudflare IRL Hackathon** using Workers, Durable Objects, D1, and WebSockets.

**Test repo:** [lakshyashishir/test-for-hack](https://github.com/lakshyashishir/test-for-hack) — default sandbox for PR testing (auto-selected in UI).

## Quick Start

```bash
npm install
npm run db:local          # init DB (run once; includes github columns migration)
cp .dev.vars.example .dev.vars   # optional: add GITHUB_TOKEN for higher API limits
npm run dev
```

Open http://127.0.0.1:8787 — **no second terminal needed**. The built-in cloud agent runs automatically when you create a task.

### What is real vs simulated?

| Real | Notes |
|------|-------|
| GitHub repo search & metadata | |
| Live file listing from repo | |
| Cloud runner — template file commits + PR | No terminal |
| Claude Code runner — real local edits + PR | `npm run agent:claude` |
| WebSocket log streaming | |
| Approval flow (incl. git push) | |
| Task persistence in D1 | |

## Architecture

- **Workers + Hono** — REST API
- **Durable Objects** — WebSocket broadcast hub
- **D1** — agents, tasks, logs, approvals
- **Local heuristics** — task parsing & plans (no Workers AI / no LLM spam)
- **Agent SDK** — universal protocol for any coding agent

See [PLAN.md](./PLAN.md) for the full build plan.

## Agent Integration

Any agent can integrate via REST:

```js
import NanoClient from './agent-sdk/index.js';

const client = await NanoClient.register('http://127.0.0.1:8787', {
  name: 'My Agent',
  type: 'custom',
});

await client.log(taskId, 'Working on src/auth.ts');
const approval = await client.requestApproval(taskId, 'file_delete', { files: ['old.ts'] });
const status = await client.waitForApproval(approval.id);
```

### Claude Code (real local agent)

Claude Code runs on your Mac and polls Nano for **local** tasks:

```bash
# 1. Register (prints API key once)
npm run agent:claude

# 2. Save credentials
export NANO_API_KEY=nano_...
export GITHUB_TOKEN=ghp_...

# 3. Start polling (keep running)
npm run agent:claude
```

In the app, pick **💻 Claude Code** as the runner when creating a task. Approve the git push from your phone when prompted.

**Cloud runner (no Mac):** see [docs/RUNNER.md](./docs/RUNNER.md) — Docker image + wake URL ready for Cloudflare Containers when you have credits.

### Claude Code / Codex (architecture)

No native remote API exists. Use a **sidecar adapter** (see `agent-sdk/examples/claude-code-adapter.js`) that wraps CLI output and forwards to Nano. The built-in cloud agent handles GitHub; adapters are for local Claude Code / Codex.

## Deploy

```bash
# Create production D1 (once)
wrangler d1 create harness-db
# Update database_id in wrangler.toml

npm run db:migrate
npm run deploy
```

**Live:** https://nano.lakshyashishir1.workers.dev (after deploy)

## Demo Script

1. Show problem: can't monitor agents away from desk
2. Open phone PWA → agent dashboard
3. Create task from phone
4. Mock agent runs → logs stream
5. Approve file delete on phone
6. Task completes → mention Cloudflare stack

## License

MIT
