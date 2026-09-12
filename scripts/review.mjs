#!/usr/bin/env node
// The code-review CLI.
//
// Nothing here writes to HEAD, the real index, or the user's working files. The
// only writes land inside a run folder under `<git-common-dir>/code-review/`,
// and only folders holding this tool's marker file are ever deleted.

import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

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

import {
  DEFAULT_TARGET,
  SLICE_DIR,
  checkParse,
  checkPlan,
  describePlan,
  parseDiff,
  planSlices,
  sliceText,
} from "./lib/diff.mjs";

const CLI = "review.mjs";

/** Documented in `SKILL.md`. Callers depend on these numbers. */
const EXIT = { ok: 0, failed: 1, dirty: 2, conflict: 3, baseRef: 4, gitTooOld: 5, check: 6 };

/** A review of this many changed lines or more is split across subagents. */
const MASSIVE_CHANGED_LINES = 1000;

const RUN_ROOT_NAME = "code-review";
const MARKER_NAME = ".code-review-run";
const DIFF_CONTEXT = 10;

/** Project files worth reading before reviewing, in the order to prefer them. */
const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", "CRUSH.md", "README.md"];

class UsageError extends Error {}

/** A failure we can state in one line. `report` prints it without a stack. */
class ReviewError extends Error {
  constructor(message, exitCode = EXIT.failed) {
    super(message);
    this.exitCode = exitCode;
  }
}

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

  split --run-dir <path> [--target <lines>]
      Cut the run's full.diff into slices of about --target changed lines, at
      file and hunk boundaries only. Writes slices/slice-NN.diff and
      manifest.json into the run folder, then checks that the slices hold every
      hunk of the diff. Prints one JSON object on stdout.

      --run-dir <path>     Run folder printed by prep. Required.
      --target <lines>     Changed lines to aim for in one slice.
                           Default: ${DEFAULT_TARGET}.

  clean --run-dir <path> | --all
      Remove run folders. Only folders this tool created, directly under
      <git-common-dir>/code-review/, can be removed. Prints one JSON object on
      stdout naming what was removed.

      --run-dir <path>     The one run folder to remove.
      --all                Remove every run folder left in the run root.

Exit codes:
  0  ready
  1  failed
  2  the working directory has staged or unstaged changes
  3  merging the base branch conflicts
  4  the base ref is missing or names no commit
  5  git is older than 2.38
  6  a self-check failed
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

  const runRoot = managedRunRoot(opts);
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
    // `numstat` counts 0 for a pure rename and a mode-only change, and reports
    // `- -` for a binary file, so zero changed lines is not an empty branch.
    // Only an empty `files` array means there is nothing in the diff at all.
    if (files.length === 0) {
      warn("The merged diff holds no files. There is nothing to review.");
    } else if (changed === 0) {
      warn("The merged diff holds no changed lines, only renames, mode changes, or binary changes.");
      warn("That is still work to review.");
    }

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

/**
 * Cut a prepared diff into review-sized slices, then prove the cut lost
 * nothing. A quiet bad split is the fault worth catching here: without the
 * checks below, a dropped hunk means code that no one reviews and nothing
 * reports.
 */
function split(args) {
  const flags = parseFlags(args, { runDir: "value", target: "value" });
  if (flags.runDir === undefined) throw new UsageError("split needs --run-dir <path>.");
  const target = wholeNumber(flags.target, "--target", DEFAULT_TARGET);

  const runDir = resolveManagedRun(flags.runDir);
  const diffFile = join(runDir, "full.diff");
  // `latin1` maps every byte to one character and back, so a diff of Latin-1,
  // CP1252, or Shift-JIS source keeps its exact bytes on the way through. Read
  // as `utf8`, every byte that is not valid UTF-8 would come back as U+FFFD and
  // the slices would no longer match the source they are reviewed against.
  // `scripts/lib/diff.mjs` reads this string as bytes and decodes the paths it
  // reports itself.
  let source;
  try {
    source = readFileSync(diffFile, "latin1");
  } catch {
    throw new ReviewError(`${diffFile} is missing, so this run folder is not a finished prep.`);
  }

  const parsed = parseDiff(source);
  for (const text of parsed.warnings) warn(`diff: ${text}`);

  const parseProblems = checkParse(parsed);
  if (parseProblems.length > 0) return reportProblems("Reading the diff", parseProblems);

  const plan = planSlices({ files: parsed.files, target });
  const planProblems = checkPlan(parsed, plan);
  if (planProblems.length > 0) return reportProblems("Slicing the diff", planProblems);

  const sliceDir = join(runDir, SLICE_DIR);
  // A second split with a different target would otherwise leave the extra
  // slice files of the first one behind, and an agent could review a stale one.
  rmSync(sliceDir, { recursive: true, force: true });
  mkdirSync(sliceDir, { recursive: true });
  const writeProblems = [];
  for (const slice of plan.slices) {
    const text = sliceText(slice);
    const path = join(runDir, slice.path);
    writeFileSync(path, text, "latin1");
    const written = statSync(path).size;
    const expected = Buffer.byteLength(text, "latin1");
    if (written !== expected) writeProblems.push(`${slice.path}: wrote ${written} bytes, expected ${expected}`);
  }
  if (writeProblems.length > 0) return reportProblems("Writing the slices", writeProblems);

  if (plan.sliceCount === 0) warn("The diff holds no file sections, so no slices were written.");
  if (plan.oversized) {
    warn("Some slices hold a single hunk larger than the target and could not be cut further.");
  }

  const sourceDir = join(runDir, "source");
  if (!existsSync(sourceDir)) warn(`${sourceDir} is missing, so reviewers have no merged source to read.`);

  const manifest = {
    runDir,
    diffFile,
    sourceDir,
    sliceDir,
    manifestFile: join(runDir, "manifest.json"),
    ...describePlan(plan),
  };
  writeFileSync(manifest.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  print(manifest);
  return EXIT.ok;
}

/**
 * Remove run folders. `--run-dir` ends one finished review. `--all` is the
 * recovery form for when the run folder of an interrupted review is no longer
 * known. Both go through the same two guards as `split`, so the only folders
 * this can delete are the marked direct children of the run root.
 */
function clean(args) {
  const flags = parseFlags(args, { runDir: "value", all: "flag" });
  const one = flags.runDir !== undefined;
  const sweep = flags.all === true;
  // Checked before any git call, so a mistyped command line says so plainly
  // even outside a repository.
  if (one && sweep) throw new UsageError("clean takes --run-dir <path> or --all, not both.");
  if (!one && !sweep) throw new UsageError("clean needs --run-dir <path> or --all.");

  const runRoot = managedRunRoot();
  let removed;
  if (sweep) {
    removed = sweepRuns(runRoot);
  } else {
    const runDir = resolveManagedRun(flags.runDir, runRoot);
    rmSync(runDir, { recursive: true, force: true });
    removed = [runDir];
  }

  print({ runRoot, removed });
  return EXIT.ok;
}

/** Name every problem on stderr, then hand back the self-check exit code. */
function reportProblems(what, problems) {
  warn(`${what} found ${problems.length} problem(s):`);
  for (const problem of problems) warn(`  ${problem}`);
  warn("The slices are therefore not trustworthy. Nothing was reviewed.");
  return EXIT.check;
}

function wholeNumber(raw, name, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`${name} needs a whole number of 1 or more, got "${raw}"`);
  }
  return value;
}

/**
 * Turn a path from the caller into a run folder this tool owns. Every write and
 * every delete outside `prep` goes through here, so a typo, a symlink, or a
 * relative path cannot reach past `<git-common-dir>/code-review/`.
 */
function resolveManagedRun(candidate, runRoot = managedRunRoot()) {
  let root;
  try {
    root = realpathSync(runRoot);
  } catch {
    throw new ReviewError(`${runRoot} does not exist, so there are no runs. Run prep first.`);
  }
  let real;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new ReviewError(`--run-dir "${candidate}" does not exist.`);
  }
  if (dirname(real) !== root) {
    throw new ReviewError(`--run-dir "${candidate}" is not a run folder directly under ${root}.`);
  }
  if (!isMarkedRun(real)) {
    throw new ReviewError(`--run-dir "${candidate}" holds no ${MARKER_NAME} file, so this tool did not create it.`);
  }
  return real;
}

/**
 * Where every run folder lives. No work-tree lookup, so the commands that only
 * need this still work from inside the git folder, where `git rev-parse
 * --show-toplevel` fails.
 */
function managedRunRoot(opts = {}) {
  return join(gitCommonDir(opts), RUN_ROOT_NAME);
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

const COMMANDS = { prep, split, clean };

function main(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return EXIT.ok;
  }
  // Own properties only: a plain object also answers "constructor", "toString",
  // and the rest of `Object.prototype`, and calling one of those crashes.
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!run) throw new UsageError(`unknown command "${command}"`);
  return run(rest);
}

function report(error) {
  if (error instanceof UsageError) {
    warn(`${error.message}\nTry "node ${CLI} --help".`);
    return EXIT.failed;
  }
  if (error instanceof ReviewError) {
    warn(error.message);
    return error.exitCode;
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
