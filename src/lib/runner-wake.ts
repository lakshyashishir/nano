import type { Env, Task } from '../types';

/** Ping an external runner (VM / container) to wake from sleep when a local task is queued */
export async function wakeLocalRunner(env: Env, task: Task): Promise<void> {
  const url = env.RUNNER_WAKE_URL;
  if (!url) return;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'task_created',
        taskId: task.id,
        description: task.description,
        repo: `${task.github_owner}/${task.github_repo}`,
        branch: task.github_branch,
      }),
    });
  } catch {
    // Runner may be asleep; polling still works as fallback
  }
}
