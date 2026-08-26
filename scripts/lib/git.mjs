// Every git call the code-review CLI makes lives here.
//
// Nothing in this file may write to HEAD, the real index, or the working tree.
// The one write is `materializeTree`, which uses its own throwaway index outside
// the repository and extracts files into a folder the caller owns.

import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Big enough for a whole diff of a very large branch. */
const MAX_BUFFER = 256 * 1024 * 1024;

/** First git release with `merge-tree --write-tree`. */
export const MERGE_TREE_MIN_VERSION = { major: 2, minor: 38 };

// Paths never worth reviewing. The caller may add more with `--exclude`.
// Every pattern is prefixed with a double-star directory match, so it matches at
// any depth, including the top level.
export const DEFAULT_EXCLUDES = [
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/go.sum",
  "**/Cargo.lock",
  "**/uv.lock",
  "**/poetry.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.snap",
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/*.svg",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.ico",
  "**/*.webp",
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
  "**/*.eot",
];

// User config must not change the shape of a diff we parse. `color.ui=always`,
// `diff.noprefix`, `diff.relative`, and an external diff driver all would.
const DIFF_CONFIG = ["-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.relative=false"];
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv"];

export class GitError extends Error {
  constructor(message, code = "GIT_FAILED") {
    super(message);
    this.name = "GitError";
    this.code = code;
  }
}

/**
 * Run git and hand back its result. A non-zero exit is a value, not an error,
 * because several callers treat a non-zero exit as a normal answer.
 *
 * `opts.stdoutFd` sends stdout straight to a file descriptor, so a huge diff
 * never becomes a JavaScript string.
 */
export function git(args, opts = {}) {
  const { cwd, env, stdoutFd, maxBuffer = MAX_BUFFER } = opts;
  const result = spawnSync("git", args, {
    cwd,
    // GIT_OPTIONAL_LOCKS=0 stops `git status` from refreshing the real index,
    // which would rewrite the index file on disk.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
    encoding: "utf8",
    maxBuffer,
    shell: false,
    stdio: ["ignore", stdoutFd === undefined ? "pipe" : stdoutFd, "pipe"],
  });
  if (result.error) {
    throw new GitError(`could not run git ${args.join(" ")}: ${result.error.message}`, "GIT_SPAWN_FAILED");
  }
  // A signal death must not be reported as an exit code, or `mergeTree` would
  // read it as a merge conflict.
  if (result.signal) {
    throw new GitError(`git ${args.join(" ")} was killed by ${result.signal}`, "GIT_KILLED");
  }
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Run git where a non-zero exit is a real fault. */
export function gitOrThrow(args, opts = {}) {
  const result = git(args, opts);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || "no error output";
    throw new GitError(`git ${args.join(" ")} exited with ${result.code}: ${detail}`);
  }
  return result;
}

const trimmed = (args, opts) => gitOrThrow(args, opts).stdout.trim();

export function repoRoot(opts = {}) {
  return resolve(trimmed(["rev-parse", "--show-toplevel"], opts));
}

/** The `.git` folder shared by the main checkout and every linked worktree. */
export function gitCommonDir(opts = {}) {
  return resolve(opts.cwd ?? process.cwd(), trimmed(["rev-parse", "--git-common-dir"], opts));
}

export function gitVersion(opts = {}) {
  const text = trimmed(["--version"], opts);
  const found = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!found) {
    throw new GitError(`could not read a version number from "${text}"`, "GIT_VERSION_UNREADABLE");
  }
  return { major: Number(found[1]), minor: Number(found[2]), patch: found[3] ? Number(found[3]) : 0 };
}

/** Throws `GitError` with code `GIT_TOO_OLD` below git 2.38. */
export function requireMergeTree(opts = {}) {
  const version = gitVersion(opts);
  const { major, minor } = MERGE_TREE_MIN_VERSION;
  if (version.major < major || (version.major === major && version.minor < minor)) {
    throw new GitError(
      `git ${version.major}.${version.minor}.${version.patch} is too old. ` +
        `This skill needs git ${major}.${minor} or newer for "git merge-tree --write-tree".`,
      "GIT_TOO_OLD",
    );
  }
  return version;
}

/**
 * Staged or unstaged changes to tracked files. Untracked files are fine, so
 * they are left out of the check.
 */
export function isDirty(opts = {}) {
  const lines = splitLines(gitOrThrow(["status", "--porcelain", "--untracked-files=no"], opts).stdout);
  return { dirty: lines.length > 0, lines };
}

/** The commit a ref points at, or `null` when it names no commit. */
export function resolveRef(ref, opts = {}) {
  const result = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], opts);
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Pick the base to review against.
 *
 * Auto-detection asks for `refs/heads/main` and `refs/heads/master` by full
 * path, so a tag named `main` cannot win. An explicit base that names no commit
 * is reported, never quietly replaced by `main`.
 *
 * Returns `{ ok: true, ref, sha, shortName }`, or
 * `{ ok: false, reason: "invalid-base" | "no-base", ref }`.
 */
export function findBaseRef(explicit, opts = {}) {
  if (explicit) {
    const sha = resolveRef(explicit, opts);
    if (!sha) return { ok: false, reason: "invalid-base", ref: explicit };
    return { ok: true, ref: explicit, sha, shortName: shortRefName(explicit) };
  }
  for (const ref of ["refs/heads/main", "refs/heads/master"]) {
    const sha = resolveRef(ref, opts);
    if (sha) return { ok: true, ref, sha, shortName: shortRefName(ref) };
  }
  return { ok: false, reason: "no-base", ref: null };
}

/**
 * How many commits the base is behind a remote-tracking ref that is already in
 * this repository. Never fetches, so this describes local knowledge only.
 *
 * Returns `{ upstream, behind }` with the full tracking ref name, or `null`
 * when no tracking ref is present.
 */
export function behindTrackingRef(baseRef, opts = {}) {
  const upstream = trackingRefFor(baseRef, opts);
  if (!upstream) return null;
  const behind = Number(trimmed(["rev-list", "--count", `${baseRef}..${upstream}`], opts));
  return { upstream, behind };
}

// `<ref>@{upstream}` only accepts a short branch name, so ask for-each-ref
// instead. It takes the full ref name and prints nothing when no upstream is
// configured.
function trackingRefFor(baseRef, opts) {
  const fullName = fullRefName(baseRef, opts);
  if (fullName?.startsWith("refs/heads/")) {
    const upstream = trimmed(["for-each-ref", "--format=%(upstream)", fullName], opts);
    if (upstream && resolveRef(upstream, opts)) return upstream;
  }
  const guess = `refs/remotes/origin/${shortRefName(baseRef)}`;
  return resolveRef(guess, opts) ? guess : null;
}

/** The full ref name a ref shorthand points at, or `null` for a raw commit id. */
function fullRefName(ref, opts) {
  const result = git(["rev-parse", "--symbolic-full-name", ref], opts);
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

/** `branch` is `null` on a detached HEAD, so no caller may assume a name. */
export function headInfo(opts = {}) {
  const sha = trimmed(["rev-parse", "HEAD"], opts);
  const symbolic = git(["symbolic-ref", "--quiet", "--short", "HEAD"], opts);
  const branch = symbolic.code === 0 ? symbolic.stdout.trim() || null : null;
  return { sha, branch };
}

/**
 * Merge the two commits inside the object store. HEAD, the index, and the
 * working tree are untouched, even when the working tree is dirty.
 *
 * Exit 0 means a clean merge and stdout line 1 is the tree id. Exit 1 means a
 * conflict: line 1 is still a tree id, then the conflicting paths, then a blank
 * line and human messages we ignore.
 */
export function mergeTree(baseSha, headSha, opts = {}) {
  const result = git(["merge-tree", "--write-tree", "--name-only", baseSha, headSha], opts);
  const lines = result.stdout.split("\n");
  const tree = (lines[0] ?? "").trim();
  if (result.code === 0) {
    if (!tree) throw new GitError("git merge-tree printed no tree id", "MERGE_TREE_NO_OID");
    return { ok: true, tree };
  }
  if (result.code === 1) {
    const conflicts = [];
    for (const line of lines.slice(1)) {
      if (line.trim() === "") break;
      conflicts.push(line);
    }
    return { ok: false, tree: tree || null, conflicts };
  }
  const detail = result.stderr.trim() || "no error output";
  throw new GitError(`git merge-tree exited with ${result.code}: ${detail}`, "MERGE_TREE_FAILED");
}

/**
 * Write the files of `tree` into `outDir`, so agents can read the merged source
 * the diff describes. A temporary index outside the repository keeps the real
 * index untouched.
 */
export function materializeTree({ tree, outDir }, opts = {}) {
  const target = resolve(outDir);
  mkdirSync(target, { recursive: true });
  const indexDir = mkdtempSync(join(tmpdir(), "code-review-index-"));
  const env = { ...opts.env, GIT_INDEX_FILE: join(indexDir, "index") };
  try {
    gitOrThrow(["read-tree", tree], { ...opts, env });
    // The trailing separator is what makes --prefix a folder rather than a
    // filename prefix.
    gitOrThrow(["checkout-index", "--all", "--force", `--prefix=${target}${sep}`], { ...opts, env });
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
  return target;
}

/** Write `git diff <from> <to>` to a file without holding it in memory. */
export function diffToFile({ from, to, outPath, excludes = DEFAULT_EXCLUDES, context = 10 }, opts = {}) {
  const path = resolve(outPath);
  const fd = openSync(path, "w");
  try {
    const args = [
      ...DIFF_CONFIG,
      "diff",
      ...DIFF_FLAGS,
      `-U${context}`,
      from,
      to,
      "--",
      ...pathspecs(excludes),
    ];
    const result = git(args, { ...opts, stdoutFd: fd });
    if (result.code !== 0) {
      const detail = result.stderr.trim() || "no error output";
      throw new GitError(`git diff exited with ${result.code}: ${detail}`);
    }
  } finally {
    closeSync(fd);
  }
  return { path, bytes: statSync(path).size };
}

/**
 * Per-file change counts, straight from git. Binary files report zero changed
 * lines and carry `binary: true`.
 *
 * Returns `[{ path, oldPath, status, added, deleted, changed, binary }]`.
 */
export function numstat({ from, to, excludes = DEFAULT_EXCLUDES }, opts = {}) {
  const diffArgs = (extra) => [
    ...DIFF_CONFIG,
    "diff",
    ...DIFF_FLAGS,
    ...extra,
    "-z",
    "--find-renames",
    from,
    to,
    "--",
    ...pathspecs(excludes),
  ];
  const counts = parseNumstatZ(gitOrThrow(diffArgs(["--numstat"]), opts).stdout);
  const statuses = parseNameStatusZ(gitOrThrow(diffArgs(["--name-status"]), opts).stdout);
  return counts.map((entry) => {
    const named = statuses.get(entry.path);
    return {
      path: entry.path,
      oldPath: entry.oldPath ?? named?.oldPath ?? null,
      status: named?.status ?? "M",
      added: entry.added,
      deleted: entry.deleted,
      changed: entry.added + entry.deleted,
      binary: entry.binary,
    };
  });
}

/** Total changed lines across the records `numstat` returned. */
export function totalChanged(records) {
  return records.reduce((sum, record) => sum + record.changed, 0);
}

export function commitSubjects(from, to, opts = {}) {
  return splitLines(gitOrThrow(["log", "--oneline", "--no-color", "--no-decorate", `${from}..${to}`], opts).stdout);
}

/**
 * `top` makes every pathspec relative to the repository root, so the result does
 * not depend on the folder git runs in. `glob` is what gives a leading
 * double-star its gitignore meaning of "at any depth, including the top level".
 * Without `glob`, an exclusion pattern that starts with a double-star misses
 * top-level files, because the slash in the pattern needs a real slash in the
 * path.
 */
export function pathspecs(excludes) {
  return [":(top)", ...excludes.map((pattern) => `:(top,glob,exclude)${pattern}`)];
}

export function shortRefName(ref) {
  return ref.replace(/^refs\/(?:heads|remotes|tags)\//, "");
}

function splitLines(text) {
  return text.split("\n").filter((line) => line.length > 0);
}

// `--numstat -z` writes "added TAB deleted TAB path NUL". A rename or copy
// leaves the path field empty and follows it with old NUL new NUL.
function parseNumstatZ(text) {
  const fields = text.split("\0");
  const records = [];
  let i = 0;
  while (i < fields.length) {
    const head = fields[i++];
    if (head === "") continue;
    const [addedText, deletedText, inlinePath] = head.split("\t");
    let path = inlinePath;
    let oldPath = null;
    if (path === "" || path === undefined) {
      oldPath = fields[i++] ?? "";
      path = fields[i++] ?? "";
    }
    const binary = addedText === "-" || deletedText === "-";
    records.push({
      path,
      oldPath,
      added: binary ? 0 : Number(addedText),
      deleted: binary ? 0 : Number(deletedText),
      binary,
    });
  }
  return records;
}

// `--name-status -z` writes "status NUL path NUL", and for a rename or copy
// "R100 NUL old NUL new NUL".
function parseNameStatusZ(text) {
  const fields = text.split("\0");
  const byPath = new Map();
  let i = 0;
  while (i < fields.length) {
    const token = fields[i++];
    if (token === "") continue;
    const status = token[0];
    if (status === "R" || status === "C") {
      const oldPath = fields[i++] ?? "";
      const path = fields[i++] ?? "";
      byPath.set(path, { status, oldPath });
    } else {
      const path = fields[i++] ?? "";
      byPath.set(path, { status, oldPath: null });
    }
  }
  return byPath;
}
