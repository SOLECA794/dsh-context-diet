#!/usr/bin/env node
/**
 * Push one commit to GitHub through the REST API instead of git-over-https.
 *
 * `github.com:443` is unreachable on this network while `api.github.com:443`
 * is not, so `git push` dies with "Recv failure: Connection was reset" no
 * matter how many times it is retried. The Git Data API can do the same job
 * over the one host that answers.
 *
 * Only the files that differ between `--from` and `--to` are uploaded, so a
 * one-file fix does not re-send the tree.
 *
 *   GITHUB_TOKEN=... node scripts/push-via-api.mjs \
 *       --repo SOLECA794/dsh-context-diet --from HEAD~1 --to HEAD --branch main
 *
 * The remote branch must already point at `--from`; the script refuses
 * otherwise rather than force anything.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = 'https://api.github.com';

function parseArgs(argv) {
  const out = { repo: null, from: 'HEAD~1', to: 'HEAD', branch: 'main', dryRun: false, force: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    // `--dry-run` must land on `out.dryRun`, not `out['dry-run']`. Reading the
    // kebab key elsewhere silently turned every rehearsal into a real push.
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else out[key] = argv[++i];
  }
  if (!out.repo) throw new Error('--repo owner/name is required');
  return out;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

async function call(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'dsh-context-diet-push',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const args = parseArgs(process.argv);
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN is required');

const [owner, name] = args.repo.split('/');
const base = `/repos/${owner}/${name}`;

const fromSha = git('rev-parse', args.from);
const toSha = git('rev-parse', args.to);
const message = git('log', '-1', '--format=%B', toSha);

const remote = await call(token, 'GET', `${base}/git/ref/heads/${args.branch}`);
if (remote.object.sha !== fromSha && !args.force) {
  throw new Error(
    `remote ${args.branch} is at ${remote.object.sha}, expected ${fromSha}. ` +
      'Refusing to push on top of unknown history (pass --force to overwrite it).',
  );
}
if (remote.object.sha !== fromSha) {
  console.warn(`! remote ${args.branch} was at ${remote.object.sha}; overwriting`);
}

// --name-status so deletions are visible; every other status carries two paths.
const lines = git('diff', '--name-status', fromSha, toSha)
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status: status[0], path: rest[rest.length - 1] };
  });

/** The mode git itself recorded. Guessing from an extension gets it wrong. */
function modeOf(sha, path) {
  const [parsed] = git('ls-tree', sha, '--', path).split('\n');
  const meta = parsed.split('\t')[0].trim().split(/\s+/);
  return meta[0];
}

console.log(`pushing ${lines.length} path(s) ${fromSha.slice(0, 7)} -> ${toSha.slice(0, 7)}`);
for (const entry of lines) console.log(`  ${entry.status} ${entry.path}`);
if (args.dryRun) process.exit(0);

const tree = [];
for (const entry of lines) {
  if (entry.status === 'D') {
    tree.push({ path: entry.path, mode: '100644', type: 'blob', sha: null });
    continue;
  }
  const bytes = readFileSync(resolve(entry.path));
  const blob = await call(token, 'POST', `${base}/git/blobs`, {
    content: bytes.toString('base64'),
    encoding: 'base64',
  });
  tree.push({ path: entry.path, mode: modeOf(toSha, entry.path), type: 'blob', sha: blob.sha });
  console.log(`  blob ${entry.path} ${blob.sha.slice(0, 7)} ${bytes.length}B`);
}

const newTree = await call(token, 'POST', `${base}/git/trees`, {
  base_tree: git('rev-parse', `${fromSha}^{tree}`),
  tree,
});

// Send the committer's own offset so `adopt-remote-commit.mjs` can rebuild the
// object without guessing which zone it was written in. The API wants ISO 8601
// here even though the stored object keeps epoch+offset.
const iso = git('log', '-1', '--format=%aI', toSha);
const author = {
  name: git('log', '-1', '--format=%an', toSha),
  email: git('log', '-1', '--format=%ae', toSha),
  date: iso,
};

const commit = await call(token, 'POST', `${base}/git/commits`, {
  message,
  tree: newTree.sha,
  parents: [fromSha],
  author,
  committer: author,
});

await call(token, 'PATCH', `${base}/git/refs/heads/${args.branch}`, {
  sha: commit.sha,
  force: Boolean(args.force),
});

console.log(`\npushed ${commit.sha}`);
console.log(`https://github.com/${args.repo}/commit/${commit.sha}`);
