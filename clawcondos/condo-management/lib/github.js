/**
 * GitHub Integration
 * Creates repos, manages collaborators, configures git remotes with auth.
 * Used by condos.create to auto-provision GitHub repos when agent account is configured.
 */

import https from 'https';
import { execSync } from 'child_process';

/**
 * Make an authenticated GitHub API request.
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g. /user/repos)
 * @param {string} token - GitHub PAT
 * @param {object} [body] - Request body
 * @returns {Promise<object>}
 */
function githubRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ClawCondos/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 204) {
          return resolve({ ok: true });
        }
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err = new Error(`GitHub API ${res.statusCode}: ${parsed.message || data}`);
            err.status = res.statusCode;
            err.response = parsed;
            reject(err);
          }
        } catch {
          const err = new Error(`GitHub API ${res.statusCode}: ${data}`);
          err.status = res.statusCode;
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('GitHub API request timed out'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Make an authenticated GitHub API request, returning response headers and status.
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {string} token - GitHub PAT
 * @param {object} [body] - Request body
 * @returns {Promise<{ data: object|null, headers: object, statusCode: number }>}
 */
function githubRequestWithHeaders(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ClawCondos/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch { /* non-JSON response */ }
        resolve({ data, headers: res.headers, statusCode: res.statusCode });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('GitHub API request timed out'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Verify a GitHub token by calling the API and optionally checking repo access.
 * @param {string} token - GitHub PAT (classic or fine-grained)
 * @param {string} [repoUrl] - Optional repo URL to check access against
 * @returns {Promise<object>} Verification result
 */
export async function verifyGitHubToken(token, repoUrl) {
  try {
    const { data, headers, statusCode } = await githubRequestWithHeaders('GET', '/user', token);

    if (statusCode === 401 || statusCode === 403) {
      return { valid: false, error: `Authentication failed (${statusCode}): ${data?.message || 'Invalid token'}` };
    }
    if (statusCode < 200 || statusCode >= 300) {
      return { valid: false, error: `GitHub API returned ${statusCode}: ${data?.message || 'Unknown error'}` };
    }

    // Extract scopes (classic PATs have X-OAuth-Scopes, fine-grained don't)
    const scopesHeader = headers['x-oauth-scopes'];
    const scopes = scopesHeader ? scopesHeader.split(',').map(s => s.trim()).filter(Boolean) : [];
    const tokenType = scopesHeader !== undefined ? 'classic' : 'fine-grained';

    const result = {
      valid: true,
      login: data.login,
      name: data.name || null,
      scopes,
      tokenType,
    };

    // Optionally check repo access
    if (repoUrl && typeof repoUrl === 'string') {
      const ghMatch = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (ghMatch) {
        const [, owner, repo] = ghMatch;
        try {
          const repoResp = await githubRequestWithHeaders('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token);
          if (repoResp.statusCode >= 200 && repoResp.statusCode < 300) {
            result.repoAccess = {
              accessible: true,
              permissions: repoResp.data?.permissions || {},
            };
          } else {
            result.repoAccess = {
              accessible: false,
              error: `${repoResp.statusCode}: ${repoResp.data?.message || 'Cannot access repo'}`,
            };
          }
        } catch (repoErr) {
          result.repoAccess = { accessible: false, error: repoErr.message };
        }
      } else {
        result.repoAccess = { accessible: null, note: 'Non-GitHub URL' };
      }
    }

    return result;
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Create a GitHub repository.
 * @param {string} token - GitHub PAT
 * @param {string} name - Repository name
 * @param {object} [options]
 * @param {string} [options.org] - Organization (creates under org if set)
 * @param {string} [options.description] - Repo description
 * @param {boolean} [options.isPrivate=false] - Private repo
 * @returns {Promise<object>} GitHub repo object
 */
export async function createRepo(token, name, options = {}) {
  const { org, description, isPrivate = false } = options;
  const path = org ? `/orgs/${encodeURIComponent(org)}/repos` : '/user/repos';
  return githubRequest('POST', path, token, {
    name,
    description: description || '',
    private: isPrivate,
    auto_init: false,
  });
}

/**
 * Add a collaborator to a repository.
 * @param {string} token - GitHub PAT
 * @param {string} owner - Repo owner (user or org)
 * @param {string} repo - Repo name
 * @param {string} username - Collaborator username
 * @param {string} [permission='admin'] - Permission level
 * @returns {Promise<object>}
 */
export async function addCollaborator(token, owner, repo, username, permission = 'admin') {
  return githubRequest('PUT',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`,
    token,
    { permission }
  );
}

/**
 * Configure git remote origin with token-based auth.
 * The token is embedded in the URL so all subsequent push/pull operations authenticate automatically.
 * @param {string} repoPath - Local git repo path
 * @param {string} cloneUrl - HTTPS clone URL (e.g. https://github.com/owner/repo.git)
 * @param {string} token - GitHub PAT
 */
export function setupGitRemote(repoPath, cloneUrl, token) {
  const authedUrl = cloneUrl.replace('https://', `https://x-access-token:${token}@`);

  try {
    execSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Remote exists — update it
    execSync(`git remote set-url origin ${JSON.stringify(authedUrl)}`, {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch {
    // Remote doesn't exist — add it
    execSync(`git remote add origin ${JSON.stringify(authedUrl)}`, {
      cwd: repoPath,
      stdio: 'pipe',
    });
  }
}

/**
 * Push a branch to the remote.
 * @param {string} repoPath - Local git repo path
 * @param {string} [refspec='HEAD'] - Branch or refspec to push
 * @param {object} [options]
 * @param {boolean} [options.setUpstream=false] - Set upstream tracking
 * @returns {{ ok: boolean, error?: string }}
 */
export function pushBranch(repoPath, refspec = 'HEAD', options = {}) {
  const { setUpstream = false } = options;
  const flags = [];
  if (setUpstream) flags.push('-u');

  try {
    execSync(`git push ${flags.join(' ')} origin ${refspec}`, {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 60000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Create a pull request on GitHub.
 * @param {string} token - GitHub PAT
 * @param {string} owner - Repo owner (user or org)
 * @param {string} repo - Repo name
 * @param {object} options
 * @param {string} options.head - Branch to merge from
 * @param {string} options.base - Branch to merge into (e.g. 'main')
 * @param {string} options.title - PR title
 * @param {string} [options.body] - PR description
 * @returns {Promise<object>} GitHub PR object (includes html_url, number)
 */
export async function createPullRequest(token, owner, repo, { head, base, title, body }) {
  return githubRequest('POST',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    token,
    { head, base, title, body: body || '' }
  );
}

/**
 * Full GitHub repo initialization flow:
 * 1. Create repo on GitHub
 * 2. Configure git remote with auth
 * 3. Push initial commit
 * 4. Add manager as collaborator (if configured)
 *
 * @param {string} repoPath - Local git workspace path
 * @param {object} githubConfig - GitHub service config from store
 * @param {string} condoName - Condo name (used for repo name)
 * @param {string} [description] - Repo description
 * @returns {Promise<{ ok: boolean, repoUrl?: string, cloneUrl?: string, fullName?: string, repoName?: string, error?: string }>}
 */
export async function initGitHubRepo(repoPath, githubConfig, condoName, description) {
  const { agentToken, agentUsername, org, managerUsername, autoCollaborator } = githubConfig;

  if (!agentToken || !agentUsername) {
    return { ok: false, error: 'GitHub agent account not fully configured' };
  }

  // Sanitize condo name for repo name
  const repoName = condoName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'project';

  try {
    // Create the repo (try clean name, fall back to name-with-random-suffix on conflict)
    let repo;
    try {
      repo = await createRepo(agentToken, repoName, {
        org,
        description: description || `${condoName} — managed by ClawCondos`,
      });
    } catch (err) {
      if (err.status === 422) {
        const suffix = Math.random().toString(36).slice(2, 8);
        repo = await createRepo(agentToken, `${repoName}-${suffix}`, {
          org,
          description: description || `${condoName} — managed by ClawCondos`,
        });
      } else {
        throw err;
      }
    }

    const repoUrl = repo.html_url;
    const cloneUrl = repo.clone_url;
    const fullName = repo.full_name;

    // Configure remote and push
    setupGitRemote(repoPath, cloneUrl, agentToken);

    // Determine the current branch and push
    let branch;
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      branch = 'main';
    }
    const pushResult = pushBranch(repoPath, branch, { setUpstream: true });
    if (!pushResult.ok) {
      return { ok: false, error: `Repo created but push failed: ${pushResult.error}`, repoUrl, fullName };
    }

    // Add manager as collaborator (best-effort)
    if (autoCollaborator && managerUsername) {
      try {
        const owner = org || agentUsername;
        await addCollaborator(agentToken, owner, repo.name, managerUsername, 'admin');
      } catch {
        // Non-critical — repo is already created and pushed
      }
    }

    return { ok: true, repoUrl, cloneUrl, fullName, repoName: repo.name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
