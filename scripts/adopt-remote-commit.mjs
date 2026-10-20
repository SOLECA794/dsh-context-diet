#!/usr/bin/env node
/**
 * Rebuild a commit that was created through the GitHub API as a local object,
 * so the local branch and the remote branch keep the same tip sha.
 *
 * Pushing via `scripts/push-via-api.mjs` creates the commit server-side, which
 * leaves the local checkout one commit behind with no way to `git fetch` on a
 * network where `github.com:443` is unreachable. A commit object is plain
 * text, so it can be rebuilt from the metadata the API reports: same tree,
 * same parents, same identities and the same instant.
 *
 * Two details are not reported by the API and have to be recovered by trying
 * the small set of possibilities:
 *
 *   - the author's UTC offset (the API normalises dates to Z, while the stored
 *     object keeps the offset the committer was in);
 *   - whether the message carries a trailing newline.
 *
 * Every candidate is hashed and compared against the remote sha. Exactly one
 * must match, and only then is the branch moved — a wrong reconstruction would
 * fork history silently, which is worse than leaving the branch behind.
 *
 *   GITHUB_TOKEN=... node scripts/adopt-remote-commit.mjs \
 *       --repo SOLECA794/dsh-context-diet --sha <remote sha> --branch main
 */

import { execFileSync } from 'node:child_process';

const API = 'https://api.github.com';

function parseArgs(argv) {
  const out = { repo: null, sha: null, branch: 'main', dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  if (!out.repo || !out.sha) throw new Error('--repo and --sha are required');
  return out;
}

function git(args, input) {
  return execFileSync('git', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}

const args = parseArgs(process.argv);
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN is required');

const [owner, name] = args.repo.split('/');
const res = await fetch(`${API}/repos/${owner}/${name}/git/commits/${args.sha}`, {
  headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
});
if (!res.ok) throw new Error(`commit fetch -> ${res.status} ${await res.text()}`);
const commit = await res.json();

const epoch = Math.floor(Date.parse(commit.author.date) / 1000);
if (!Number.isFinite(epoch)) throw new Error(`unparseable date ${commit.author.date}`);

// The host's own offset first, then UTC, then the remaining plausible zones.
const localOffsetMinutes = -new Date().getTimezoneOffset();
const offsetOf = (minutes) => {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
};
const offsets = [...new Set([offsetOf(localOffsetMinutes), '+0000', '+0800', '-0700', '+0100'])];

const identity = (who, offset) => `${who.name} <${who.email}> ${epoch} ${offset}`;

const matches = [];
for (const offset of offsets) {
  for (const trailing of ['', '\n']) {
    const headers = [
      `tree ${commit.tree.sha}`,
      ...commit.parents.map((p) => `parent ${p.sha}`),
      `author ${identity(commit.author, offset)}`,
      `committer ${identity(commit.committer, offset)}`,
    ];
    const raw = `${headers.join('\n')}\n\n${commit.message}${trailing}`;
    const sha = git(['hash-object', '-t', 'commit', '--stdin'], raw).trim();
    if (sha === args.sha) matches.push({ offset, trailing });
  }
}

if (matches.length !== 1) {
  throw new Error(
    `expected exactly one reconstruction to match ${args.sha}, got ${matches.length}. ` +
      'Refusing to move the branch on a guess.',
  );
}

const [match] = matches;
console.log(`rebuilt ${args.sha} (offset ${match.offset}, trailing newline ${match.trailing ? 'yes' : 'no'})`);
git(['hash-object', '-t', 'commit', '-w', '--stdin'], buildRaw(commit, match));

if (args.dryRun) process.exit(0);
git(['update-ref', `refs/heads/${args.branch}`, args.sha]);
console.log(`refs/heads/${args.branch} -> ${args.sha}`);

function buildRaw(c, m) {
  const headers = [
    `tree ${c.tree.sha}`,
    ...c.parents.map((p) => `parent ${p.sha}`),
    `author ${identity(c.author, m.offset)}`,
    `committer ${identity(c.committer, m.offset)}`,
  ];
  return `${headers.join('\n')}\n\n${c.message}${m.trailing}`;
}
