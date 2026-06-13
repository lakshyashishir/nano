export interface GitHubRepo {
  owner: string;
  repo: string;
  full_name: string;
  html_url: string;
  default_branch: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  topics: string[];
  avatar_url: string;
  permissions?: { push: boolean; admin: boolean };
}

export async function githubFetch(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Nano-Agent/0.1',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`https://api.github.com${path}`, { headers });
}

export function parseGitHubUrl(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim();
  const patterns = [
    /github\.com\/([^/]+)\/([^/?#]+)/i,
    /^([^/]+)\/([^/]+)$/,
  ];
  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
  }
  return null;
}

export async function fetchRepo(
  owner: string,
  repo: string,
  token?: string
): Promise<GitHubRepo> {
  const res = await githubFetch(`/repos/${owner}/${repo}`, token);
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message || `GitHub API error ${res.status}`);
  }
  const data = await res.json() as Record<string, unknown>;
  const ownerObj = data.owner as { login: string; avatar_url: string };
  const perms = data.permissions as { push?: boolean; admin?: boolean } | undefined;
  return {
    owner: ownerObj.login,
    repo: data.name as string,
    full_name: data.full_name as string,
    html_url: data.html_url as string,
    default_branch: data.default_branch as string,
    description: (data.description as string) ?? null,
    language: (data.language as string) ?? null,
    stargazers_count: data.stargazers_count as number,
    forks_count: data.forks_count as number,
    open_issues_count: data.open_issues_count as number,
    topics: (data.topics as string[]) ?? [],
    avatar_url: ownerObj.avatar_url,
    permissions: perms ? { push: !!perms.push, admin: !!perms.admin } : undefined,
  };
}

export async function searchRepos(
  query: string,
  token?: string
): Promise<GitHubRepo[]> {
  const res = await githubFetch(
    `/search/repositories?q=${encodeURIComponent(query)}&per_page=12&sort=stars`,
    token
  );
  if (!res.ok) throw new Error('GitHub search failed');
  const data = await res.json() as { items: Record<string, unknown>[] };
  return data.items.map((item) => {
    const owner = item.owner as { login: string; avatar_url: string };
    return {
      owner: owner.login,
      repo: item.name as string,
      full_name: item.full_name as string,
      html_url: item.html_url as string,
      default_branch: (item.default_branch as string) || 'main',
      description: (item.description as string) ?? null,
      language: (item.language as string) ?? null,
      stargazers_count: item.stargazers_count as number,
      forks_count: item.forks_count as number,
      open_issues_count: item.open_issues_count as number,
      topics: (item.topics as string[]) ?? [],
      avatar_url: owner.avatar_url,
    };
  });
}

export async function listRepoContents(
  owner: string,
  repo: string,
  branch: string,
  token?: string
): Promise<string[]> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/contents/?ref=${encodeURIComponent(branch)}`,
    token
  );
  if (!res.ok) return [];
  const items = await res.json() as Array<{ name: string; type: string }>;
  return items.filter((i) => i.type === 'file' || i.type === 'dir').map((i) => i.name);
}

export async function fetchReadmeSnippet(
  owner: string,
  repo: string,
  token?: string
): Promise<string | null> {
  const res = await githubFetch(`/repos/${owner}/${repo}/readme`, token);
  if (!res.ok) return null;
  const data = await res.json() as { content: string };
  const decoded = atob(data.content.replace(/\n/g, ''));
  return decoded.slice(0, 400);
}

export async function getBranchSha(
  owner: string,
  repo: string,
  branch: string,
  token?: string
): Promise<string> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    token
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message || `Could not resolve branch ${branch}`);
  }
  const data = await res.json() as { object: { sha: string } };
  return data.object.sha;
}

export async function createBranch(
  owner: string,
  repo: string,
  branchName: string,
  fromSha: string,
  token: string
): Promise<string> {
  const createRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Nano-Agent/0.1',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: fromSha }),
  });
  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message || `Failed to create branch ${branchName}`);
  }
  return `https://github.com/${owner}/${repo}/tree/${branchName}`;
}

export async function getFileSha(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token: string
): Promise<string | null> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    token
  );
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const data = await res.json() as { sha: string };
  return data.sha;
}

export function toBase64(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function commitFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  branch: string,
  message: string,
  token: string,
  existingSha?: string | null
): Promise<string> {
  const body: Record<string, string> = {
    message,
    content: toBase64(content),
    branch,
  };
  if (existingSha) body.sha = existingSha;

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Nano-Agent/0.1',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message || `Failed to commit ${path}`);
  }
  const data = await res.json() as { commit: { html_url: string } };
  return data.commit.html_url;
}

export async function listUserRepos(token: string): Promise<GitHubRepo[]> {
  const res = await githubFetch('/user/repos?per_page=20&sort=updated&affiliation=owner,collaborator', token);
  if (!res.ok) return [];
  const items = await res.json() as Record<string, unknown>[];
  return items.map((data) => {
    const owner = data.owner as { login: string; avatar_url: string };
    const perms = data.permissions as { push?: boolean; admin?: boolean } | undefined;
    return {
      owner: owner.login,
      repo: data.name as string,
      full_name: data.full_name as string,
      html_url: data.html_url as string,
      default_branch: (data.default_branch as string) || 'main',
      description: (data.description as string) ?? null,
      language: (data.language as string) ?? null,
      stargazers_count: data.stargazers_count as number,
      forks_count: data.forks_count as number,
      open_issues_count: data.open_issues_count as number,
      topics: (data.topics as string[]) ?? [],
      avatar_url: owner.avatar_url,
      permissions: perms ? { push: !!perms.push, admin: !!perms.admin } : undefined,
    };
  });
}
