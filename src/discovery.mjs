// Read-only discovery for one repository: GitHub identity, local checkout and
// the Paseo project, main workspace, steers and workers that belong to it.
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { resolveGitHub } from './github.mjs';
import { classifyCheckouts, inspectCloneTarget } from './local.mjs';
import { LABEL, METADATA_KEY, parentOf } from './paseo.mjs';

const STEER_TITLE = /^Steer ([A-Z])$/;
const MAIN_TITLE = /(^|· )Main$/;

function real(path, realpath = realpathSync) {
  if (!path) return null;
  try {
    return realpath(path);
  } catch {
    return resolve(path);
  }
}

function isWorktreeWorkspace(workspace) {
  return workspace.workspaceKind === 'worktree' || workspace.project?.checkout?.isPaseoOwnedWorktree === true;
}

/** Normalizes a repository list entry: "owner/repo", a URL or { repo, parentDir?, checkout? }. */
export function normalizeEntry(entry, config) {
  const value = typeof entry === 'string' ? { repo: entry } : { ...entry };
  if (typeof value.repo !== 'string') throw new Error(`Repository entry needs "repo": ${JSON.stringify(entry)}`);
  return { repo: value.repo, parentDir: resolve(value.parentDir ?? config.checkoutRoot), checkout: value.checkout ? resolve(value.checkout) : null };
}

export function discoverRepository(entry, { config, gh, git, checkouts, paseo, realpath = realpathSync, inspectTarget = inspectCloneTarget }) {
  const { repo: input, parentDir, checkout: explicitCheckout } = normalizeEntry(entry, config);
  const github = resolveGitHub(gh, input, config.github.owner);
  const forkRepo = github.fork.repo ?? null;
  const forkName = forkRepo?.fullName ?? github.fork.planned ?? null;
  const repoName = forkName ? forkName.split('/')[1] : null;
  const expectedPath = repoName ? join(parentDir, repoName) : null;

  const workspaceAt = (path) => paseo.workspaces.filter((w) => !isWorktreeWorkspace(w) && real(w.workspaceDirectory, realpath) === path);
  const { exact, related } = classifyCheckouts(checkouts, { fork: forkName, upstream: github.upstream?.fullName, source: github.source?.fullName });

  const isMain = (w) => w.metadata?.[METADATA_KEY]?.main === true || MAIN_TITLE.test((w.title ?? w.name ?? '').trim());
  let checkout = null;
  const checkoutIssues = [];
  if (explicitCheckout) {
    const wanted = real(explicitCheckout, realpath);
    checkout = exact.find((c) => c.path === wanted) ?? null;
    if (!checkout) checkoutIssues.push(`Requested checkout ${explicitCheckout} is not a checkout with origin ${forkName}`);
  } else if (exact.length === 1) checkout = exact[0];
  else if (exact.length > 1) {
    // Several clones of the fork: only unambiguous signals decide, otherwise ask.
    const atExpected = exact.filter((c) => c.path === real(expectedPath, realpath));
    const withMain = exact.filter((c) => workspaceAt(c.path).some(isMain));
    const pick = withMain.length === 1 ? withMain : atExpected;
    if (pick.length === 1) checkout = pick[0];
    else checkoutIssues.push(`Several checkouts have origin ${forkName}: ${exact.map((c) => c.path).join(', ')}; name one with {"repo": ..., "checkout": <path>}`);
  }
  const cloneTarget = expectedPath && !checkout && !checkoutIssues.length ? inspectTarget(config.checkoutRoot, parentDir, expectedPath) : null;

  let upstreamRemote = null;
  if (checkout && github.upstream) {
    const name = config.github.upstreamRemote;
    const current = checkout.repos[name] ?? null;
    upstreamRemote = !(name in checkout.remotes)
      ? { status: 'missing' }
      : current === github.upstream.fullName.toLowerCase()
        ? { status: 'ok' }
        : { status: 'mismatch', url: checkout.remotes[name] };
  }

  const path = checkout?.path ?? null;
  const mainCandidates = path ? workspaceAt(path) : [];
  const projectIds = new Set(mainCandidates.map((w) => w.projectId).filter(Boolean));
  for (const project of paseo.projects) if (path && real(project.projectRootPath, realpath) === path) projectIds.add(project.projectId);
  const projects = paseo.projects.filter((p) => projectIds.has(p.projectId));

  // Several local workspaces may share one checkout (one per task); only a marked or
  // Main-titled one is the main workspace. Marked wins over title.
  const marked = mainCandidates.filter((w) => w.metadata?.[METADATA_KEY]?.main === true);
  const titled = mainCandidates.filter(isMain);
  const mainMatches = marked.length ? marked : titled;
  const mainWorkspace = mainMatches.length === 1 ? mainMatches[0] : null;

  // Steers are identified by labels; an unlabelled top-level "Steer X" in the main
  // workspace is a legacy steer that can be adopted.
  const repoKey = forkName?.toLowerCase();
  const labelled = paseo.agents.filter((a) => a.labels?.[LABEL.role] === 'steer' && a.labels?.[LABEL.repo]?.toLowerCase() === repoKey);
  const legacy = mainWorkspace
    ? paseo.agents.filter((a) => a.workspaceId === mainWorkspace.id && !a.archivedAt && !a.labels?.[LABEL.role] && STEER_TITLE.test((a.title ?? '').trim()))
    : [];
  const steerIds = new Set([...labelled, ...legacy].map((a) => a.id));
  const projectWorkspaceIds = new Set(paseo.workspaces.filter((w) => projectIds.has(w.projectId)).map((w) => w.id));
  const workers = paseo.agents.filter((a) => !a.archivedAt && steerIds.has(parentOf(a)));

  return {
    input,
    parentDir,
    github,
    forkName,
    expectedPath,
    cloneTarget,
    checkout,
    checkoutIssues,
    relatedCheckouts: related.map((c) => ({ path: c.path, remotes: c.remotes })),
    upstreamRemote,
    projects,
    mainCandidates: mainMatches,
    otherLocalWorkspaces: mainCandidates.filter((w) => !mainMatches.includes(w)),
    mainWorkspace,
    steers: { labelled, legacy },
    workers,
    projectWorkspaceIds: [...projectWorkspaceIds],
    providers: paseo.providers,
  };
}

export { STEER_TITLE };
