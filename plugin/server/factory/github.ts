// @ts-nocheck
// GENERATED from src/github.mjs by npm run plugin:sync. Do not edit.
// Read-only GitHub discovery through the authenticated gh CLI.
import { execFileSync } from 'node:child_process';

const NAME = '[A-Za-z0-9_.-]+';
const INPUT_PATTERNS = [
  new RegExp(`^https?://(?:www\\.)?github\\.com/(${NAME})/(${NAME}?)(?:\\.git)?/?$`, 'i'),
  new RegExp(`^(?:ssh://)?git@github\\.com[:/](${NAME})/(${NAME}?)(?:\\.git)?/?$`, 'i'),
  new RegExp(`^(${NAME})/(${NAME}?)$`),
];

export class GitHubNotFound extends Error {}
const MAX_OWNER_FORKS = 100;

/** Normalizes a GitHub URL, SSH remote or owner/repo shorthand. */
export function parseRepoInput(input) {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  for (const pattern of INPUT_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match && match[2] && !match[2].endsWith('.git') && match[1] !== '.' && match[2] !== '.' && match[1] !== '..' && match[2] !== '..') {
      return { owner: match[1], name: match[2], fullName: `${match[1]}/${match[2]}` };
    }
  }
  throw new Error(`Not a GitHub repository: ${JSON.stringify(input)}`);
}

/** Same normalization for git remote URLs; returns lower-cased owner/name or null. */
export function remoteToFullName(url) {
  try {
    return parseRepoInput(url).fullName.toLowerCase();
  } catch {
    return null;
  }
}

export function createGh(exec = execFileSync) {
  return function gh(args) {
    try {
      return exec('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    } catch (error) {
      const stderr = String(error?.stderr ?? '');
      if (/HTTP 404|Not Found/i.test(stderr)) throw new GitHubNotFound(stderr.trim());
      throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr.trim() || error.message}`);
    }
  };
}

function summarize(data) {
  const ref = (repo) => (repo ? { fullName: repo.full_name, cloneUrl: repo.clone_url, sshUrl: repo.ssh_url } : null);
  return {
    fullName: data.full_name,
    owner: data.owner?.login,
    name: data.name,
    isFork: Boolean(data.fork),
    archived: Boolean(data.archived),
    defaultBranch: data.default_branch,
    cloneUrl: data.clone_url,
    sshUrl: data.ssh_url,
    htmlUrl: data.html_url,
    canPush: data.permissions ? Boolean(data.permissions.push) : null,
    // Publicity for the adoption privacy rule (restricted providers only run
    // on public code). Fail-closed: a missing flag stays null (unknown).
    private: typeof data.private === 'boolean' ? data.private : null,
    parent: ref(data.parent),
    source: ref(data.source),
  };
}

export function getRepo(gh, fullName) {
  return summarize(JSON.parse(gh(['api', `repos/${fullName}`])));
}

function networkRoot(repo) {
  return (repo.source?.fullName ?? repo.fullName).toLowerCase();
}

/**
 * Resolves the requested repository into the target-owner fork (or own repo),
 * its direct upstream and the original network source. Never writes.
 */
export function resolveGitHub(gh, input, owner) {
  const requested = getRepo(gh, parseRepoInput(input).fullName);
  const ownerKey = owner.toLowerCase();

  if (requested.owner.toLowerCase() === ownerKey) {
    return {
      input,
      requested: requested.fullName,
      fork: { status: 'present', repo: requested },
      upstream: requested.isFork ? requested.parent : null,
      source: requested.isFork ? requested.source : null,
      notes: requested.isFork ? [] : ['Repository is owned by the target account and is not a fork; no upstream remote is planned.'],
    };
  }

  const result = { input, requested: requested.fullName, upstream: { fullName: requested.fullName, cloneUrl: requested.cloneUrl, sshUrl: requested.sshUrl }, source: requested.source, notes: [] };
  let candidate = null;
  try {
    candidate = getRepo(gh, `${owner}/${requested.name}`);
  } catch (error) {
    if (!(error instanceof GitHubNotFound)) throw error;
  }
  if (candidate) {
    const sameNetwork = candidate.isFork && networkRoot(candidate) === networkRoot(requested);
    result.fork = sameNetwork
      ? { status: 'present', repo: candidate }
      : { status: 'conflict', reason: `${candidate.fullName} exists but is not a fork of the ${networkRoot(requested)} network` };
    if (sameNetwork && candidate.parent?.fullName.toLowerCase() !== requested.fullName.toLowerCase()) {
      result.notes.push(`Existing fork ${candidate.fullName} has parent ${candidate.parent?.fullName}, not ${requested.fullName}; it is reused and its own parent becomes upstream.`);
      result.upstream = candidate.parent;
    }
    return result;
  }

  // A renamed fork keeps its network; look it up among the direct forks, then among
  // the owner's forks whose parent is part of this network (input may be the source).
  let forks = gh(['api', '--paginate', `repos/${requested.fullName}/forks?per_page=100`, '--jq', `.[] | select(.owner.login | ascii_downcase == "${ownerKey}") | .full_name`])
    .split('\n').map((line) => line.trim()).filter(Boolean);
  if (!forks.length) {
    // Fallback only: compare the network source of each of the owner's forks.
    const owned = JSON.parse(gh(['repo', 'list', owner, '--fork', '--limit', String(MAX_OWNER_FORKS + 1), '--json', 'nameWithOwner']) || '[]');
    if (owned.length > MAX_OWNER_FORKS) {
      result.fork = { status: 'conflict', reason: `${owner} has more than ${MAX_OWNER_FORKS} forks; pass the fork URL itself` };
      return result;
    }
    forks = owned.map((r) => r.nameWithOwner).filter((name) => networkRoot(getRepo(gh, name)) === networkRoot(requested));
  }
  if (forks.length === 1) {
    result.fork = { status: 'present', repo: getRepo(gh, forks[0]) };
    if (result.fork.repo.parent && result.fork.repo.parent.fullName.toLowerCase() !== requested.fullName.toLowerCase()) {
      result.notes.push(`Fork ${forks[0]} has parent ${result.fork.repo.parent.fullName}; that parent becomes upstream.`);
      result.upstream = result.fork.repo.parent;
    }
  }
  else if (forks.length > 1) result.fork = { status: 'conflict', reason: `Several forks of ${requested.fullName} exist for ${owner}: ${forks.join(', ')}` };
  else result.fork = { status: 'missing', planned: `${owner}/${requested.name}` };
  return result;
}
