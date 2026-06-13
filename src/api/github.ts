import { Hono } from 'hono';
import {
  fetchRepo,
  parseGitHubUrl,
  searchRepos,
  listRepoContents,
  listUserRepos,
} from '../lib/github';
import type { Env } from '../types';

export const githubApi = new Hono<{ Bindings: Env & { GITHUB_TOKEN?: string } }>();

githubApi.get('/search', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q || q.length < 2) return c.json({ error: 'Query must be at least 2 characters' }, 400);
  try {
    const repos = await searchRepos(q, c.env.GITHUB_TOKEN);
    return c.json({ repos });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

githubApi.get('/resolve', async (c) => {
  const url = c.req.query('url')?.trim();
  if (!url) return c.json({ error: 'url is required' }, 400);
  const parsed = parseGitHubUrl(url);
  if (!parsed) return c.json({ error: 'Invalid GitHub URL. Use owner/repo or github.com/owner/repo' }, 400);
  try {
    const repo = await fetchRepo(parsed.owner, parsed.repo, c.env.GITHUB_TOKEN);
    return c.json({ repo });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

githubApi.get('/repo/:owner/:repo', async (c) => {
  const { owner, repo } = c.req.param();
  try {
    const data = await fetchRepo(owner, repo, c.env.GITHUB_TOKEN);
    const files = await listRepoContents(owner, repo, data.default_branch, c.env.GITHUB_TOKEN);
    return c.json({ repo: data, files });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

// User's writable repos first, then public suggestions
githubApi.get('/suggestions', async (c) => {
  const token = c.env.GITHUB_TOKEN;
  if (token) {
    try {
      const mine = await listUserRepos(token);
      const writable = mine.filter((r) => r.permissions?.push);
      if (writable.length) return c.json({ repos: writable.slice(0, 8), source: 'user' });
      if (mine.length) return c.json({ repos: mine.slice(0, 8), source: 'user' });
    } catch { /* fall through */ }
  }
  try {
    const repos = await searchRepos('cloudflare workers-sdk stars:>1000', token);
    const picks = repos.slice(0, 6);
    if (picks.length) return c.json({ repos: picks, source: 'search' });
  } catch { /* fall through */ }
  return c.json({
    source: 'fallback',
    repos: [
      {
        owner: 'cloudflare',
        repo: 'workers-sdk',
        full_name: 'cloudflare/workers-sdk',
        html_url: 'https://github.com/cloudflare/workers-sdk',
        default_branch: 'main',
        description: 'Cloudflare Workers SDK',
        language: 'TypeScript',
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
        topics: [],
        avatar_url: 'https://avatars.githubusercontent.com/u/314135?s=64',
      },
    ],
  });
});
