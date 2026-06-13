import { Hono } from 'hono';
import { TEST_REPO } from '../config';
import {
  fetchRepo,
  parseGitHubUrl,
  searchRepos,
  listRepoContents,
  listUserRepos,
  seedEmptyRepo,
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

githubApi.post('/seed-test-repo', async (c) => {
  const token = c.env.GITHUB_TOKEN;
  if (!token) return c.json({ error: 'GITHUB_TOKEN required' }, 400);
  try {
    const seeded = await seedEmptyRepo(TEST_REPO.owner, TEST_REPO.repo, token);
    const repo = await fetchRepo(TEST_REPO.owner, TEST_REPO.repo, token);
    return c.json({ seeded, repo });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

// Test sandbox first, then user's writable repos
githubApi.get('/suggestions', async (c) => {
  const token = c.env.GITHUB_TOKEN;
  const repos: Awaited<ReturnType<typeof fetchRepo>>[] = [];
  let defaultRepo = TEST_REPO.full_name;

  if (token) {
    try {
      await seedEmptyRepo(TEST_REPO.owner, TEST_REPO.repo, token);
    } catch { /* repo may already exist */ }
    try {
      const testRepo = await fetchRepo(TEST_REPO.owner, TEST_REPO.repo, token);
      repos.push(testRepo);
    } catch { /* ignore */ }

    try {
      const mine = await listUserRepos(token);
      for (const r of mine) {
        if (r.full_name !== TEST_REPO.full_name) repos.push(r);
      }
    } catch { /* fall through */ }
  }

  if (repos.length) {
    return c.json({ repos: repos.slice(0, 8), source: 'test+sandbox', defaultRepo });
  }

  try {
    const picks = (await searchRepos('stars:>100', token)).slice(0, 4);
    if (picks.length) return c.json({ repos: picks, source: 'search', defaultRepo: picks[0]?.full_name });
  } catch { /* fall through */ }

  return c.json({
    source: 'fallback',
    defaultRepo: TEST_REPO.full_name,
    repos: [
      {
        owner: TEST_REPO.owner,
        repo: TEST_REPO.repo,
        full_name: TEST_REPO.full_name,
        html_url: TEST_REPO.html_url,
        default_branch: 'main',
        description: 'Nano PR test sandbox',
        language: null,
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
        topics: [],
        avatar_url: 'https://avatars.githubusercontent.com/u/314135?s=64',
        permissions: { push: true, admin: true },
      },
    ],
  });
});
