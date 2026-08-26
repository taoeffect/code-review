#!/usr/bin/env node
// The code-review CLI.
//
// Nothing here writes to HEAD, the real index, or the user's working files. The
// only writes land inside a run folder under `<git-common-dir>/code-review/`,
// and only folders holding this tool's marker file are ever deleted.

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_EXCLUDES,
  GitError,
  behindTrackingRef,
  commitSubjects,
  diffToFile,
  findBaseRef,
  gitCommonDir,
  headInfo,
  isDirty,
  materializeTree,
  mergeTree,
  numstat,
  repoRoot,
  requireMergeTree,
  shortRefName,
  totalChanged,
} from "./lib/git.mjs";

const CLI = "review.mjs";

/** Documented in `SKILL.md`. Callers depend on these numbers. */
const EXIT = { ok: 0, failed: 1, dirty: 2, conflict: 3, baseRef: 4, gitTooOld: 5 };

/** A review of this many changed lines or more is split across subagents. */
const MASSIVE_CHANGED_LINES = 1000;

const RUN_ROOT_NAME = "code-review";
const MARKER_NAME = ".code-review-run";
const DIFF_CONTEXT = 10;

/** Project files worth reading before reviewing, in the order to prefer them. */
const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", "CRUSH.md", "README.md"];

class UsageError extends Error {}

const warn = (text) => process.stderr.write(`${text}\n`);

function usage() {
  return `Usage: node ${CLI} <command> [options]

Commands:
  prep [--base <ref>] [--exclude <pattern>]...
      Check that the working directory is clean, merge the base branch inside
      the git object store, then write the merged diff and a snapshot of the
      merged source into a new run folder. Prints one JSON object on stdout
      describing the run. Warnings go to stderr.

      --base <ref>         Base to review against. Default: refs/heads/main,
                           then refs/heads/master.
      --exclude <pattern>  Extra path pattern to leave out of the diff.
                           Repeatable. Added to the built-in list.

Exit codes:
  0  ready
  1  failed
  2  the working directory has staged or unstaged changes
  3  merging the base branch conflicts
  4  the base ref is missing or names no commit
  5  git is older than 2.38
`;
}

/**
 * Flags only, in `--name value` or `--name=value` form. `spec` maps a camelCase
 * option name to `"value"`, `"list"`, or `"flag"`. Anything unnamed is a fault,
 * because every subcommand here takes options and no positional arguments.
 */
function parseFlags(args, spec) {
  const parsed = {};
  for (const [name, kind] of Object.entries(spec)) {
    if (kind === "list") parsed[name] = [];
  }
  let index = 0;
  while (index < args.length) {
    const token = args[index++];
    const found = /^--([a-z][a-z0-9-]*)(?:=([\s\S]*))?$/.exec(token);
    if (!found) throw new UsageError(`unexpected argument "${token}"`);
    const [, dashed, inlineValue] = found;
    const kind = spec[camelCase(dashed)];
    if (!kind) throw new UsageError(`unknown option "--${dashed}"`);
    if (kind === "flag") {
      if (inlineValue !== undefined) throw new UsageError(`--${dashed} takes no value`);
      parsed[camelCase(dashed)] = true;
      continue;
    }
    const value = inlineValue ?? args[index++];
    if (value === undefined || value === "") throw new UsageError(`--${dashed} needs a value`);
    if (kind === "list") parsed[camelCase(dashed)].push(value);
    else parsed[camelCase(dashed)] = value;
  }
  return parsed;
}

const camelCase = (dashed) => dashed.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());

/**
 * Prepare a review: merged diff, merged source snapshot, and the counts and
 * references the reviewing agent needs.
 */
function prep(args) {
  const flags = parseFlags(args, { base: "value", exclude: "list" });

  // Before anything else, so an unusable git fails the same way inside and
  // outside a repository.
  requireMergeTree();

  const opts = { cwd: repoRoot() };
  const excludes = [...DEFAULT_EXCLUDES, ...flags.exclude];

  const status = isDirty(opts);
  if (status.dirty) {
    warn("The working directory has staged or unstaged changes:");
    for (const line of status.lines) warn(`  ${line}`);
    warn("Commit, stash, or discard them, then run prep again.");
    return EXIT.dirty;
  }

  const base = findBaseRef(flags.base, opts);
  if (!base.ok) {
    if (base.reason === "invalid-base") {
      warn(`--base "${base.ref}" names no commit in this repository.`);
    } else {
      warn("No base branch found: this repository has neither refs/heads/main nor refs/heads/master.");
      warn("Name the base branch with --base <ref>.");
    }
    return EXIT.baseRef;
  }

  const head = headInfo(opts);
  const tracking = behindTrackingRef(base.ref, opts);
  if (tracking && tracking.behind > 0) {
    const short = shortRefName(tracking.upstream);
    warn(`Local ${base.shortName} is ${tracking.behind} commit(s) behind ${short}.`);
    warn(`prep never fetches, so ${short} is only what this repository already knows.`);
    warn("The merged diff may therefore miss recent base-branch changes.");
  }

  const merged = mergeTree(base.sha, head.sha, opts);
  if (!merged.ok) {
    warn(`Merging ${base.shortName} into HEAD conflicts in ${merged.conflicts.length} file(s):`);
    for (const path of merged.conflicts) warn(`  ${path}`);
    warn("The merge happened in the object store, so there is nothing to undo.");
    warn("Resolve the conflicts, then run prep again.");
    return EXIT.conflict;
  }

  const runRoot = join(gitCommonDir(opts), RUN_ROOT_NAME);
  const stale = sweepRuns(runRoot);
  if (stale.length > 0) {
    warn(`Removed ${stale.length} run folder(s) left by an interrupted review.`);
  }

  const runDir = createRun(runRoot);
  try {
    const from = base.sha;
    const to = merged.tree;
    const files = numstat({ from, to, excludes }, opts);
    const changed = totalChanged(files);
    const diff = diffToFile(
      { from, to, outPath: join(runDir, "full.diff"), excludes, context: DIFF_CONTEXT },
      opts,
    );
    const sourceDir = materializeTree({ tree: to, outDir: join(runDir, "source") }, opts);
    if (changed === 0) warn("The merged diff holds no changed lines. There is nothing to review.");

    print({
      baseRef: base.shortName,
      baseSha: base.sha,
      headSha: head.sha,
      headBranch: head.branch,
      baseBehindTrackingRef: tracking ? tracking.behind : null,
      runDir,
      diffFile: diff.path,
      sourceDir,
      totalChanged: changed,
      files,
      massive: changed >= MASSIVE_CHANGED_LINES,
      commits: commitSubjects(base.sha, head.sha, opts),
      contextFiles: CONTEXT_FILES.filter((name) => existsSync(join(sourceDir, name))),
    });
    return EXIT.ok;
  } catch (error) {
    // A half-written run is worse than none: the next prep would sweep it away
    // anyway, and split must never read one.
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}

/** One JSON object, pretty-printed, and nothing else on stdout. */
function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * A fresh run folder holding the marker file that says this tool owns it. The
 * name is a timestamp plus random bytes, so two runs cannot collide and the
 * folder is still readable to a person.
 */
function createRun(runRoot) {
  mkdirSync(runRoot, { recursive: true });
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const runId = `run-${stamp}-${randomBytes(3).toString("hex")}`;
  const runDir = join(runRoot, runId);
  // Not recursive, so a name already in use is an error rather than a takeover.
  mkdirSync(runDir);
  writeFileSync(
    join(runDir, MARKER_NAME),
    `${JSON.stringify({ tool: "code-review", runId, createdAt, pid: process.pid }, null, 2)}\n`,
  );
  return runDir;
}

/**
 * Remove the run folders of interrupted reviews. A review is one run and cannot
 * resume, so any run already sitting here is finished with. Only marked direct
 * children go, which leaves anything else under the git folder alone.
 */
function sweepRuns(runRoot) {
  const removed = [];
  let entries;
  try {
    entries = readdirSync(runRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return removed;
    throw error;
  }
  for (const entry of entries) {
    // False for a symlink, so a link pointing outside the run root is skipped.
    if (!entry.isDirectory()) continue;
    const candidate = join(runRoot, entry.name);
    if (!isMarkedRun(candidate)) continue;
    rmSync(candidate, { recursive: true, force: true });
    removed.push(candidate);
  }
  return removed;
}

/** A run folder is ours when it holds the marker file as a regular file. */
function isMarkedRun(dir) {
  try {
    return lstatSync(join(dir, MARKER_NAME)).isFile();
  } catch {
    return false;
  }
}

const COMMANDS = { prep };

function main(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return EXIT.ok;
  }
  const run = COMMANDS[command];
  if (!run) throw new UsageError(`unknown command "${command}"`);
  return run(rest);
}

function report(error) {
  if (error instanceof UsageError) {
    warn(`${error.message}\nTry "node ${CLI} --help".`);
    return EXIT.failed;
  }
  if (error instanceof GitError) {
    warn(error.message);
    return error.code === "GIT_TOO_OLD" ? EXIT.gitTooOld : EXIT.failed;
  }
  // Anything else is a fault in this tool, so show where it came from.
  warn(error?.stack ?? String(error));
  return EXIT.failed;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.exitCode = report(error);
}
