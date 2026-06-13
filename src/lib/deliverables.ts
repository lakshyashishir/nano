import type { GitHubRepo } from './github';

export interface TaskDeliverable {
  path: string;
  content: string;
}

const ADD_FILE_RE =
  /(?:add|create|make|write|build)\s+(?:a\s+)?(?:new\s+)?(?:file\s+)?[`"']?([\w][\w./-]*\.(?:md|txt|json|ts|js|tsx|jsx|py|html|css|yml|yaml))[`"']?/i;
const NAMED_FILE_RE = /\b([`"']?)([\w][\w.-]*\.(?:md|txt|html|css))\1\b/gi;
const SAY_RE = /\bsay\s+(.+)$/i;
const CONTENT_RE = /\b(?:with\s+(?:content|text)|containing)\s+[`"'](.+?)[`"']/i;
const REF_REPO_RE = /(?:in|for|about)\s+(?:the\s+)?(?:repo(?:sitory)?\s+)?[`"']?([\w.-]+\/[\w.-]+)[`"']?/i;

export interface DeliverableContext {
  contextRepo?: string;
  contextReadme?: string;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractReferencedRepo(description: string): string | undefined {
  const m = description.match(REF_REPO_RE);
  return m?.[1];
}

function buildMarkdownContent(path: string, body: string, description: string): string {
  const trimmed = body.trim();
  if (path.endsWith('.md')) {
    if (/^(hi|hello|hey)$/i.test(trimmed)) {
      return `# ${capitalize(trimmed)}\n\n${trimmed}\n`;
    }
    if (trimmed.startsWith('#')) return `${trimmed}\n`;
    const heading = path
      .replace(/\.md$/i, '')
      .split(/[/\\]/)
      .pop()!
      .replace(/[-_]/g, ' ');
    return `# ${heading}\n\n${trimmed}\n`;
  }
  if (path.endsWith('.json')) {
    return `${JSON.stringify({ message: trimmed, task: description }, null, 2)}\n`;
  }
  return `${trimmed}\n`;
}

function parseExplicitFiles(description: string): TaskDeliverable[] {
  const trimmed = description.trim();
  const paths = new Set<string>();

  const addMatch = trimmed.match(ADD_FILE_RE);
  if (addMatch) paths.add(addMatch[1]);

  for (const m of trimmed.matchAll(NAMED_FILE_RE)) {
    paths.add(m[2]);
  }

  if (!paths.size) return [];

  let body = '';
  const sayMatch = trimmed.match(SAY_RE);
  const contentMatch = trimmed.match(CONTENT_RE);
  if (sayMatch) {
    body = sayMatch[1].trim().replace(/[`"']/g, '');
  } else if (contentMatch) {
    body = contentMatch[1].trim();
  } else {
    body = trimmed
      .replace(ADD_FILE_RE, '')
      .replace(/\b(add|create|make|write|build|a|new|file)\b/gi, ' ')
      .replace(/\b[\w.-]+\.(?:md|txt|html)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (!body) body = 'Done.';

  return [...paths].map((path) => ({
    path,
    content: path.endsWith('.html')
      ? buildHtmlFromTask(description, path, {})
      : buildMarkdownContent(path, body, trimmed),
  }));
}

function buildCloudflareStackHtml(projectName: string, task: string, readme?: string): string {
  const excerpt = readme
    ? readme.split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(0, 3).join(' ')
    : 'Mobile-first agent control center on Cloudflare edge.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cloudflare Stack — ${projectName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: linear-gradient(145deg, #0a0a12 0%, #12121f 50%, #1a1030 100%);
      color: #e8e8f0;
      min-height: 100vh;
      padding: 24px 16px 48px;
    }
    .wrap { max-width: 720px; margin: 0 auto; }
    header { margin-bottom: 32px; }
    h1 {
      font-size: 1.75rem;
      background: linear-gradient(90deg, #f38020, #7c6cff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .sub { color: #9898b0; margin-top: 8px; font-size: 0.95rem; line-height: 1.5; }
    .grid { display: grid; gap: 14px; }
    .card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 14px;
      padding: 18px 20px;
    }
    .card h2 { font-size: 1rem; color: #f38020; margin-bottom: 8px; }
    .card p { font-size: 0.88rem; color: #b8b8d0; line-height: 1.55; }
    .flow {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 20px;
    }
    .pill {
      background: rgba(124,108,255,0.15);
      color: #a89cff;
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 500;
    }
    footer { margin-top: 36px; text-align: center; color: #666; font-size: 0.75rem; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>How ${projectName} uses Cloudflare</h1>
      <p class="sub">${excerpt}</p>
    </header>
    <div class="grid">
      <div class="card">
        <h2>⚡ Workers</h2>
        <p>REST API + built-in cloud agent run at the edge. Tasks, logs, and GitHub writes execute without a separate server.</p>
      </div>
      <div class="card">
        <h2>🔗 Durable Objects</h2>
        <p>WebSocket hub broadcasts live agent logs and approval prompts to your phone in real time.</p>
      </div>
      <div class="card">
        <h2>🗄️ D1</h2>
        <p>SQLite at the edge stores agents, tasks, logs, and approval state — persistent across sessions.</p>
      </div>
      <div class="card">
        <h2>📱 PWA + GitHub</h2>
        <p>Mobile UI approves branch/PR work. Agent creates real files, branches, and pull requests on your repos.</p>
      </div>
    </div>
    <div class="flow">
      <span class="pill">Workers</span>
      <span class="pill">Durable Objects</span>
      <span class="pill">D1</span>
      <span class="pill">WebSockets</span>
      <span class="pill">GitHub API</span>
    </div>
    <footer>Generated by Nano · Task: ${task.replace(/</g, '&lt;')}</footer>
  </div>
</body>
</html>
`;
}

function buildHtmlFromTask(
  description: string,
  path: string,
  ctx: DeliverableContext
): string {
  const project =
    ctx.contextRepo?.split('/').pop() ||
    (description.match(REF_REPO_RE)?.[1]?.split('/').pop()) ||
    'Nano';
  if (/\bcloudflare|cloudfare|workers|edge\b/i.test(description)) {
    return buildCloudflareStackHtml(project, description, ctx.contextReadme);
  }
  const title = path.replace(/\.html$/i, '').replace(/[-_]/g, ' ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
    h1 { color: #7c6cff; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>${description}</p>
</body>
</html>
`;
}

/** Resolve what files to actually commit — never fall back to plan-only meta files */
export function resolveDeliverables(
  description: string,
  repo: GitHubRepo,
  ctx: DeliverableContext = {}
): TaskDeliverable[] {
  const explicit = parseExplicitFiles(description);
  if (explicit.length) return explicit;

  const lower = description.toLowerCase();

  if (/\b(html|ui|page|landing|website|web\s*page|frontend)\b/i.test(description)) {
    const path = /\bcloudflare|cloudfare|workers\b/i.test(description)
      ? 'cloudflare.html'
      : 'index.html';
    return [{ path, content: buildHtmlFromTask(description, path, ctx) }];
  }

  if (/\b(readme|documentation|docs?)\b/i.test(description)) {
    const project = ctx.contextRepo || repo.full_name;
    return [{
      path: 'README.md',
      content: `# ${project}\n\n${description}\n\n${ctx.contextReadme?.slice(0, 500) || '_Documentation update._'}\n`,
    }];
  }

  if (/\b(write|create|add|make|build|implement|fix|update)\b/i.test(description)) {
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 32)
      .replace(/^-|-$/g, '') || 'change';
    return [{
      path: `${slug}.md`,
      content: `# Change\n\n${description}\n\n## Done by Nano\n\nThis file was created from your mobile task.\n`,
    }];
  }

  return [];
}

export { extractReferencedRepo };
