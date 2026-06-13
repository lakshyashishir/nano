import type { Task } from '../types';
import type { GitHubRepo } from './github';
import type { TaskDeliverable } from './deliverables';

export interface ParsedTask {
  title: string;
  steps: string[];
  priority: 'low' | 'normal' | 'high';
  estimatedMinutes: number;
}

const HIGH_WORDS = /\b(urgent|asap|critical|fix|bug|broken|security|prod)\b/i;
const LOW_WORDS = /\b(later|nice to have|optional|cleanup|polish|docs)\b/i;

export function parseTaskDescription(description: string): ParsedTask {
  const trimmed = description.trim();
  const sentences = trimmed
    .split(/[.!?]\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let priority: ParsedTask['priority'] = 'normal';
  if (HIGH_WORDS.test(trimmed)) priority = 'high';
  else if (LOW_WORDS.test(trimmed)) priority = 'low';

  const wordCount = trimmed.split(/\s+/).length;
  const estimatedMinutes = Math.min(120, Math.max(10, Math.round(wordCount * 1.5)));

  return {
    title: trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed,
    steps: sentences.length ? sentences : [trimmed],
    priority,
    estimatedMinutes,
  };
}

export function summarizeLogs(logs: Array<{ level: string; message: string }>): string {
  if (!logs.length) return 'No logs yet.';
  const recent = logs.slice(-8);
  const errors = recent.filter((l) => l.level === 'error').length;
  const warnings = recent.filter((l) => l.level === 'warning').length;
  const last = recent[recent.length - 1]?.message ?? '';
  const highlights = recent
    .filter((l) => l.level !== 'debug')
    .slice(-3)
    .map((l) => l.message)
    .join(' → ');
  const status = errors ? `${errors} error(s)` : warnings ? `${warnings} warning(s)` : 'running smoothly';
  return `${status}. Latest: ${last}${highlights ? `. Trail: ${highlights}` : ''}`;
}

function inferTargets(description: string, files: string[]): string[] {
  const lower = description.toLowerCase();
  const hits = files.filter((f) => {
    const name = f.toLowerCase();
    return lower.split(/\s+/).some((word) => word.length > 3 && name.includes(word));
  });
  if (hits.length) return hits.slice(0, 6);

  const byKind = files.filter((f) =>
    /^(src|lib|app|packages|server|client|public)/i.test(f) ||
    /\.(ts|tsx|js|jsx|py|go|rs|md)$/i.test(f)
  );
  return byKind.slice(0, 6);
}

export function buildTaskPlan(
  task: Task,
  repo: GitHubRepo,
  files: string[],
  readme?: string
): string {
  const targets = inferTargets(task.description, files);
  const parsed = parseTaskDescription(task.description);
  const readmeHint = readme
    ? readme.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim().slice(0, 120)
    : null;

  return `# Nano Task Plan

**Repo:** ${repo.full_name}
**Task:** ${task.description}
**Priority:** ${parsed.priority} · ~${parsed.estimatedMinutes} min

## Summary
${parsed.steps[0] || task.description}

## Repository context
- Language: ${repo.language ?? 'unknown'}
- Default branch: ${repo.default_branch}
- Top-level: ${files.slice(0, 12).join(', ') || 'n/a'}
${readmeHint ? `- README: ${readmeHint}` : ''}

## Files / areas to inspect
${targets.length ? targets.map((f) => `- \`${f}\``).join('\n') : '- Scan repo structure and match task keywords to modules'}

## Implementation steps
${parsed.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${parsed.steps.length < 3 ? `3. Run tests and lint\n4. Update docs if user-facing` : ''}

## Risks
- Verify write access and CI before merging
- Keep changes scoped to the task above
`;
}

export function buildTaskManifest(
  task: Task,
  repo: GitHubRepo,
  branch: string,
  targets: string[],
  deliverables: TaskDeliverable[] = []
): string {
  return JSON.stringify(
    {
      id: task.id,
      description: task.description,
      repo: repo.full_name,
      branch,
      targets,
      deliverables: deliverables.map((d) => d.path),
      createdAt: new Date().toISOString(),
      agent: 'nano-cloud',
    },
    null,
    2
  );
}

export type { TaskDeliverable } from './deliverables';
