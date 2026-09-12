// Every git call the code-review CLI makes lives here.
//
// Nothing in this file may write to HEAD, the real index, or the working tree.
// The one write is `materializeTree`, which only creates files under the folder
// the caller owns.

import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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
// `diff.noprefix`, `diff.mnemonicPrefix`, `diff.relative`, `diff.srcPrefix`,
// `diff.dstPrefix`, and an external diff driver all would. The two prefix keys
// arrived in git 2.41 and are not covered by `diff.noprefix=false`: without
// them a repository setting `diff.srcPrefix=i/` produces
// `diff --git i/f.txt w/f.txt`, and every path we report gains a prefix that no
// file has. Git ignores config keys it does not know, so pinning them is safe
// on 2.38 through 2.40, where no config could change the prefixes anyway.
//
// Exported with `DIFF_FLAGS` so the self-test can read a fixture diff exactly
// as the CLI does, instead of keeping a second list that can drift from this
// one.
export const DIFF_CONFIG = [
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.relative=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
];
// `--find-renames` sits here, not on one call, so the counts and the patch we
// write out describe the same trees. It overrides `diff.renames` in each of
// its three values. Left to that setting, `false` turns a rename into a full
// delete plus a full add in the patch while `numstat` still reports two
// changed lines, and `copies` turns a copy into a zero-line record in the
// patch while the counts call it a whole new file.
//
// Copies are deliberately not detected, so no diff this tool prepares holds a
// `copy from` line and a copied file is reviewed as the new file it is. Plain
// `--find-copies` only finds a copy whose source changed in the same branch,
// and it then writes the delta against the *base* version of that source,
// which is not the version the merged snapshot holds. Finding the copies worth
// naming needs `--find-copies-harder`, which inspects every unmodified file as
// a candidate source; git's manual calls that very expensive for large
// projects, and a large diff is the only input this tool exists for. The copy
// branches in the parsers below and in `scripts/lib/diff.mjs` are there to
// read a record we never ask for, not to describe something a run produces.
export const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames"];

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
 * never becomes a JavaScript string. `opts.encoding` of `latin1` keeps one
 * character per byte and `buffer` hands back raw bytes; `stderr` is always
 * text. `opts.input` is written to the process's stdin.
 */
export function git(args, opts = {}) {
  const { cwd, env, stdoutFd, input, encoding = "utf8", maxBuffer = MAX_BUFFER } = opts;
  const result = spawnSync("git", args, {
    cwd,
    // GIT_OPTIONAL_LOCKS=0 stops `git status` from refreshing the real index,
    // which would rewrite the index file on disk.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
    encoding,
    input,
    maxBuffer,
    shell: false,
    stdio: [input === undefined ? "ignore" : "pipe", stdoutFd === undefined ? "pipe" : stdoutFd, "pipe"],
  });
  if (result.error) {
    throw new GitError(`could not run git ${args.join(" ")}: ${result.error.message}`, "GIT_SPAWN_FAILED");
  }
  // A signal death must not be reported as an exit code, or `mergeTree` would
  // read it as a merge conflict.
  if (result.signal) {
    throw new GitError(`git ${args.join(" ")} was killed by ${result.signal}`, "GIT_KILLED");
  }
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? (encoding === "buffer" ? Buffer.alloc(0) : ""),
    stderr: asText(result.stderr),
  };
}

/** `stderr` stays a string even when stdout is asked for as raw bytes. */
function asText(value) {
  if (typeof value === "string") return value;
  return value === null || value === undefined ? "" : value.toString("utf8");
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
 *
 * `--ignore-submodules=dirty` is pinned for two reasons. A review compares
 * committed trees, and a submodule's content is never part of the parent's
 * tree, so edits inside one cannot reach the diff and must not stop the run.
 * And the flag overrides `submodule.<name>.ignore` and `diff.ignoreSubmodules`,
 * which would otherwise let repository config hide a changed submodule commit.
 * A submodule commit that differs from the one the parent records is a change
 * to the parent, so it is still reported, staged or not.
 */
export function isDirty(opts = {}) {
  const args = ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=dirty"];
  const lines = splitLines(gitOrThrow(args, opts).stdout);
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

const SYMLINK_MODE = "120000";
const EXEC_MODE = "100755";
/** How many blob bytes one `cat-file --batch` call is allowed to hold. */
const BLOB_BATCH_BYTES = 64 * 1024 * 1024;

/**
 * Write the files of `tree` into `outDir`, so agents can read the merged source
 * the diff describes.
 *
 * The snapshot must hold the stored bytes, because `git diff` compares stored
 * blobs. `git checkout-index` cannot promise that: it writes through git's
 * working-tree conversion, so `core.autocrlf`, `core.eol`, the `text`, `eol`,
 * and `working-tree-encoding` attributes, and any smudge filter all change the
 * content. A smudge filter is worse than a mismatch: an LFS driver would fetch
 * over the network, and a filter marked `required` whose command is missing
 * would fail the whole run. `ls-tree` plus `cat-file --batch` reads the objects
 * as they are stored, with no `--filters` and no `--textconv`.
 */
export function materializeTree({ tree, outDir }, opts = {}) {
  const target = resolve(outDir);
  mkdirSync(target, { recursive: true });
  const made = new Set();
  const blobs = [];
  for (const entry of treeEntries(tree, opts)) {
    // A submodule keeps its path as an empty folder: this tree holds none of
    // its content, so there is nothing to write.
    if (entry.type === "commit") mkdirSync(fullPath(target, entry.path), { recursive: true });
    else blobs.push(entry);
  }
  for (const batch of blobBatches(blobs)) {
    const contents = readBlobs(batch, opts);
    for (let at = 0; at < batch.length; at += 1) writeEntry(target, batch[at], contents[at], made);
  }
  return target;
}

// `ls-tree -r -z --long` writes "<mode> <type> <oid> <size>\t<path>" per entry,
// NUL-separated. `-z` hands the path over as raw bytes, so no quoting and no
// `core.quotepath` setting can change the shape. `--long` carries the blob
// size, which is what lets the reader bound how much it holds at once.
// `--full-tree` ignores the current folder, so the whole tree is extracted even
// when the caller sits in a subdirectory.
function treeEntries(tree, opts) {
  const listing = gitOrThrow(["ls-tree", "-r", "-z", "--long", "--full-tree", tree], {
    ...opts,
    encoding: "latin1",
  }).stdout;
  const entries = [];
  for (const record of listing.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    const fields = tab === -1 ? [] : record.slice(0, tab).split(/ +/);
    if (fields.length !== 4) {
      throw new GitError(`could not read the tree entry: ${record}`, "LS_TREE_UNREADABLE");
    }
    const [mode, type, oid, sizeField] = fields;
    const path = record.slice(tab + 1);
    // Git never writes such a path into a tree. A hand-made tree must not be
    // able to place a file outside the folder the caller owns.
    if (path.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(path)) {
      throw new GitError(`tree entry leaves the snapshot folder: ${path}`, "LS_TREE_PATH");
    }
    // git writes `BAD` in the size field of an object it cannot read, and
    // still exits 0.
    const size = type === "blob" ? Number(sizeField) : 0;
    if (!Number.isInteger(size) || size < 0) {
      throw new GitError(`could not read the size of ${path}: ${record}`, "LS_TREE_UNREADABLE");
    }
    entries.push({ mode, type, oid, size, path });
  }
  return entries;
}

// One `cat-file --batch` call per bounded group, so a tree of a large
// repository never becomes one huge allocation.
function* blobBatches(entries) {
  let batch = [];
  let bytes = 0;
  for (const entry of entries) {
    if (batch.length > 0 && bytes + entry.size > BLOB_BATCH_BYTES) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += entry.size;
  }
  if (batch.length > 0) yield batch;
}

// `--batch` answers every id on stdin with "<oid> <type> <size>" on one line,
// then that many bytes, then a newline.
function readBlobs(batch, opts) {
  const headroom = batch.length * 128 + 1024;
  const wanted = batch.reduce((sum, entry) => sum + entry.size, 0) + headroom;
  const result = git(["cat-file", "--batch"], {
    ...opts,
    encoding: "buffer",
    // `spawnSync` decodes a string `input` with `encoding`, and "buffer" is
    // not a decodable name, so the ids go in as bytes.
    input: Buffer.from(`${batch.map((entry) => entry.oid).join("\n")}\n`),
    maxBuffer: wanted,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || "no error output";
    throw new GitError(`git cat-file --batch exited with ${result.code}: ${detail}`, "CAT_FILE_FAILED");
  }
  const bytes = result.stdout;
  const contents = [];
  let at = 0;
  for (const entry of batch) {
    const lineEnd = bytes.indexOf(0x0a, at);
    const header = lineEnd === -1 ? "" : bytes.toString("utf8", at, lineEnd);
    const size = Number(header.split(" ")[2]);
    // An object git cannot read answers "<oid> missing" and still exits 0.
    if (!Number.isInteger(size) || lineEnd + 1 + size > bytes.length) {
      throw new GitError(
        `git cat-file --batch could not read object ${entry.oid}: ${header || "no header"}`,
        "CAT_FILE_UNREADABLE",
      );
    }
    contents.push(bytes.subarray(lineEnd + 1, lineEnd + 1 + size));
    at = lineEnd + 1 + size + 1;
  }
  return contents;
}

function writeEntry(target, entry, content, made) {
  const at = entry.path.lastIndexOf("/");
  if (at !== -1) {
    const dir = entry.path.slice(0, at);
    if (!made.has(dir)) {
      mkdirSync(fullPath(target, dir), { recursive: true });
      made.add(dir);
    }
  }
  const path = fullPath(target, entry.path);
  if (entry.mode === SYMLINK_MODE) {
    symlinkSync(content, path);
    return;
  }
  writeFileSync(path, content);
  // The executable bit is the only permission a tree carries, and the umask
  // must not be the one that decides it.
  chmodSync(path, entry.mode === EXEC_MODE ? 0o755 : 0o644);
}

// A tree path is a byte string that is not always valid UTF-8, so the exact
// bytes only survive as a Buffer path.
const fullPath = (target, path) => Buffer.concat([Buffer.from(`${target}/`), Buffer.from(path, "latin1")]);

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
 * `--raw` and `--numstat` are asked for in the one call, because the counts on
 * their own do not say whether a file was added, deleted, or renamed. Rename
 * detection is the expensive half of a large diff, and a second call over the
 * same trees would pay for it twice and could answer differently.
 *
 * Returns `[{ path, oldPath, status, added, deleted, changed, binary }]`.
 */
export function numstat({ from, to, excludes = DEFAULT_EXCLUDES }, opts = {}) {
  const args = [
    ...DIFF_CONFIG,
    "diff",
    ...DIFF_FLAGS,
    "--raw",
    "--numstat",
    "-z",
    from,
    to,
    "--",
    ...pathspecs(excludes),
  ];
  return parseRawNumstatZ(gitOrThrow(args, opts).stdout);
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

// `--raw --numstat -z` writes both sections into one NUL-separated stream:
// every status record first, then every count record. Git emits them from one
// diff queue under one filter, so the two sections describe the same files in
// the same order, and `pairRecords` refuses a stream where they do not.
//
// A status head is ":<old mode> <new mode> <old sha> <new sha> <status>" and a
// count head is "<added> TAB <deleted> TAB <path>", so a leading colon is what
// tells the two kinds apart: a count head starts with a digit or a "-".
//
// `-z` hands a path over raw, with no quoting, so only the first two tabs of a
// count head are field separators and a name holding a tab keeps its own.
// Splitting on every tab cut such a path short.
function parseRawNumstatZ(text) {
  const fields = text.split("\0");
  const statuses = [];
  const counts = [];
  let i = 0;
  while (i < fields.length) {
    const head = fields[i++];
    if (head === "") continue;
    if (head.startsWith(":")) {
      // A rename or a copy names both of its sides. Reading one as a plain
      // record would take the source path for the record's own and then read
      // the target path as the next head, desyncing the rest of the stream.
      // Our own flags never ask for copy detection (see `DIFF_FLAGS`), so the
      // `C` half of this is defensive.
      const status = rawStatus(head);
      const oldPath = status === "R" || status === "C" ? (fields[i++] ?? "") : null;
      const path = fields[i++] ?? "";
      statuses.push({ status, oldPath, path });
      continue;
    }
    const firstTab = head.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : head.indexOf("\t", firstTab + 1);
    if (secondTab === -1) {
      throw new GitError(`could not read the numstat record: ${head}`, "NUMSTAT_UNREADABLE");
    }
    const addedText = head.slice(0, firstTab);
    const deletedText = head.slice(firstTab + 1, secondTab);
    // A rename or a copy leaves the path field empty whatever its counts are,
    // "0 TAB 0 TAB" for a pure one and "1 TAB 1 TAB" for one carrying an edit,
    // and the two sides are the fields after it.
    let path = head.slice(secondTab + 1);
    let oldPath = null;
    if (path === "") {
      oldPath = fields[i++] ?? "";
      path = fields[i++] ?? "";
    }
    const binary = addedText === "-" || deletedText === "-";
    counts.push({
      path,
      oldPath,
      added: binary ? 0 : Number(addedText),
      deleted: binary ? 0 : Number(deletedText),
      binary,
    });
  }
  return pairRecords(statuses, counts);
}

// The status is the last space-separated field of a raw head, and it carries a
// similarity number on a rename or a copy, as in "R100".
function rawStatus(head) {
  const at = head.lastIndexOf(" ");
  const token = at === -1 ? "" : head.slice(at + 1);
  if (token === "") {
    throw new GitError(`could not read the raw record: ${head}`, "RAW_UNREADABLE");
  }
  return token[0];
}

// One record per file, out of the two sections that describe it. A file the
// two sections name differently is a fault worth stopping for: the alternative
// is publishing a file under a status git never gave it.
function pairRecords(statuses, counts) {
  if (statuses.length !== counts.length) {
    throw new GitError(
      `git described ${statuses.length} files by status and ${counts.length} by count`,
      "DIFF_RECORDS_DISAGREE",
    );
  }
  return counts.map((entry, at) => {
    const named = statuses[at];
    if (named.path !== entry.path || named.oldPath !== entry.oldPath) {
      throw new GitError(
        `git described ${describeChange(named)} by status and ${describeChange(entry)} by count`,
        "DIFF_RECORDS_DISAGREE",
      );
    }
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: named.status,
      added: entry.added,
      deleted: entry.deleted,
      changed: entry.added + entry.deleted,
      binary: entry.binary,
    };
  });
}

const describeChange = (record) => (record.oldPath === null ? record.path : `${record.oldPath} -> ${record.path}`);
