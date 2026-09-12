#!/usr/bin/env node
// Self-test for the code-review CLI.
//
// It builds throwaway git repositories in a temp folder, runs the real
// subcommands against them, and checks the promises the review depends on:
// every hunk reaches exactly one slice, the slices rebuild the diff byte for
// byte, only this tool's own run folders are ever removed, and HEAD, the real
// index, and the working files are the same before and after every run.
//
// This project has no build step and no other test command, so this file is the
// whole test suite. Run it with plain node:
//
//   node scripts/selftest.mjs [--only <text>] [--keep]
//
// `--only` runs the cases whose name holds that text. `--keep` leaves the temp
// folder in place for inspection.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_BATCH,
  checkParse,
  checkPlan,
  describePlan,
  fileFragment,
  parseDiff,
  planSlices,
  sliceText,
  unquotePath,
} from "./lib/diff.mjs";
import { DIFF_CONFIG, DIFF_FLAGS } from "./lib/git.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "review.mjs");
const ARGV = process.argv.slice(2);
const ONLY = flagValue("--only");
const KEEP = ARGV.includes("--keep");

const MARKER = ".code-review-run";
const RUN_ROOT = join(".git", "code-review");

function flagValue(name) {
  const at = ARGV.indexOf(name);
  return at === -1 ? null : (ARGV[at + 1] ?? null);
}

// ---------------------------------------------------------------------------
// The case runner
// ---------------------------------------------------------------------------

const cases = [];
const test = (name, body) => cases.push({ name, body });

class Check {
  constructor(name) {
    this.name = name;
    this.problems = [];
  }

  fail(message) {
    this.problems.push(message);
    return false;
  }

  ok(pass, message) {
    return pass ? true : this.fail(message);
  }

  eq(actual, wanted, message) {
    return this.ok(Object.is(actual, wanted), `${message}: got ${show(actual)}, wanted ${show(wanted)}`);
  }

  deep(actual, wanted, message) {
    const left = JSON.stringify(actual);
    const right = JSON.stringify(wanted);
    return this.ok(left === right, `${message}: got ${clip(left)}, wanted ${clip(right)}`);
  }

  has(text, needle, message) {
    return this.ok(String(text).includes(needle), `${message}: ${show(needle)} is missing from ${clip(String(text))}`);
  }

  hasNot(text, needle, message) {
    return this.ok(!String(text).includes(needle), `${message}: ${show(needle)} should not be in ${clip(String(text))}`);
  }

  none(problems, message) {
    return this.ok(problems.length === 0, `${message}: ${clip(problems.join(" | "))}`);
  }

  threw(body, wanted, message) {
    try {
      body();
    } catch (error) {
      return this.ok(error instanceof wanted, `${message}: threw ${error?.constructor?.name}, wanted ${wanted.name}`);
    }
    return this.fail(`${message}: nothing was thrown`);
  }
}

function show(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  return clip(JSON.stringify(value));
}

function clip(text, limit = 400) {
  const flat = String(text).replace(/\n/g, "\\n");
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

// ---------------------------------------------------------------------------
// Temp folders, git, and the CLI
// ---------------------------------------------------------------------------

let WORK = "";

/**
 * The machine must not reach a fixture. Without this, every fixture inherits
 * the whole global and system config plus whatever git variables the shell
 * happens to hold, and cases fail for reasons that have nothing to do with the
 * code under test: `diff.renames=false` splits a rename into a delete and an
 * add, `diff.interHunkContext=20` merges hunks that a case needs apart,
 * `core.quotepath=false` silently removes the quoted-path coverage,
 * `core.hooksPath` runs a stranger's hooks inside every commit, a system
 * `gitattributes` marked `-diff` turns a text fixture into a binary one, a
 * stray alternate object store makes objects readable that a fixture has
 * deliberately broken, and a stray `GIT_DIR` sends `git init` somewhere else
 * entirely.
 *
 * A value of `undefined` removes the variable: `spawnSync` leaves those out of
 * the child's environment. Dropping `GIT_CONFIG_COUNT` is what neutralises the
 * `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` pairs, because git reads them
 * only up to that count.
 *
 * A case that wants hostile config passes it in `env`, which is merged last and
 * therefore wins.
 */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: undefined,
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TEMPLATE_DIR: undefined,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
};

function gitAt(cwd, args, { env = {}, allowFail = false, encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...GIT_ENV, ...env },
  });
  if (result.error) throw result.error;
  if (!allowFail && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} exited with ${result.status}: ${result.stderr}`);
  }
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const gitOut = (cwd, args) => gitAt(cwd, args).stdout.trim();

/**
 * A fixture diff read the way the CLI reads it. A case that parses git's own
 * output has to ask for it with the CLI's config pins and flags, or repository
 * config, global attributes, or an external diff driver can change the shape of
 * the text and break the parse expectations.
 */
const protectedDiff = (cwd, args, opts) => gitAt(cwd, [...DIFF_CONFIG, "diff", ...DIFF_FLAGS, ...args], opts).stdout;

/** Run the real CLI as a child process, exactly as the skill does. */
function review(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...GIT_ENV, ...env },
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The one JSON object a successful subcommand prints, or `null` with a problem. */
function jsonOut(check, result, label) {
  check.eq(result.code, 0, `${label}: exit code (stderr: ${clip(result.stderr)})`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    check.fail(`${label}: stdout is not one JSON object: ${clip(result.stdout)}`);
    return null;
  }
}

/** A failure keeps stdout empty, says why on stderr, and shows no stack. */
function failedRun(check, result, code, label) {
  check.eq(result.code, code, `${label}: exit code (stderr: ${clip(result.stderr)})`);
  check.eq(result.stdout, "", `${label}: stdout must stay empty`);
  check.ok(result.stderr.trim().length > 0, `${label}: stderr must say why`);
  check.hasNot(result.stderr, "\n    at ", `${label}: no stack trace`);
}

/**
 * The local config every fixture needs. `GIT_ENV` takes the global and system
 * config away, so an identity has to be set here or no commit can be made. It
 * is a separate helper because `git clone` copies none of this from its origin.
 */
function harden(dir) {
  gitAt(dir, ["config", "user.email", "selftest@example.invalid"]);
  gitAt(dir, ["config", "user.name", "Code Review Self Test"]);
  gitAt(dir, ["config", "commit.gpgsign", "false"]);
  gitAt(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

function newRepo(name, { branch = "master" } = {}) {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  gitAt(dir, ["init", "-q", "-b", branch]);
  return harden(dir);
}

function put(dir, path, content) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

const del = (dir, path) => rmSync(join(dir, path), { recursive: true, force: true });

/**
 * Diff text the way the CLI reads it: one character per byte. `parseDiff` takes
 * a byte string, so a `utf8` read here would decode the paths a second time and
 * turn every byte that is not valid UTF-8 into U+FFFD.
 */
const readDiff = (path) => readFileSync(path, "latin1");

function commitAll(dir, message, { allowEmpty = false } = {}) {
  gitAt(dir, ["add", "-A"]);
  const args = ["commit", "-q", "-m", message];
  if (allowEmpty) args.push("--allow-empty");
  gitAt(dir, args);
}

function lines(prefix, count, from = 1) {
  let text = "";
  for (let n = from; n < from + count; n += 1) text += `${prefix} ${n}\n`;
  return text;
}

/** Blocks of 40 lines. With `changed`, ten lines of every block differ. */
function blockText(blocks, changed) {
  let text = "";
  for (let block = 1; block <= blocks; block += 1) {
    for (let line = 1; line <= 40; line += 1) {
      const edited = changed && line >= 15 && line <= 24;
      text += edited ? `block ${block} CHANGED ${line}\n` : `block ${block} line ${line}\n`;
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// The read-only proof
// ---------------------------------------------------------------------------

function snapshot(dir) {
  const env = { GIT_OPTIONAL_LOCKS: "0" };
  return {
    head: gitAt(dir, ["rev-parse", "HEAD"], { env, allowFail: true }).stdout.trim(),
    branch: gitAt(dir, ["symbolic-ref", "-q", "--short", "HEAD"], { env, allowFail: true }).stdout.trim(),
    status: gitAt(dir, ["status", "--porcelain", "--untracked-files=all"], { env, allowFail: true }).stdout,
    index: hashFile(join(dir, ".git", "index")),
    files: hashWorkingFiles(dir),
  };
}

function unchanged(check, before, after, label) {
  for (const key of ["head", "branch", "status", "index", "files"]) {
    check.eq(after[key], before[key], `${label}: ${key} changed`);
  }
}

function hashFile(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "missing";
  }
}

/** One hash over every working file, ignoring everything inside `.git`. */
function hashWorkingFiles(dir) {
  const digest = createHash("sha256");
  for (const path of walkFiles(dir)) {
    digest.update(path);
    digest.update("\0");
    digest.update(hashFile(join(dir, path)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function walkFiles(root, current = root, out = []) {
  const entries = readdirSync(current, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) walkFiles(root, path, out);
    else out.push(relative(root, path));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared repository builders
// ---------------------------------------------------------------------------

/** A base branch, plus a feature branch that adds one file. */
function simpleRepo(name, { added = 40 } = {}) {
  const dir = newRepo(name);
  put(dir, "README.md", "# self test\n");
  put(dir, "src/app.js", lines("base", 20));
  commitAll(dir, "base commit");
  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  put(dir, "src/new.js", lines("new", added));
  commitAll(dir, "feature work");
  return dir;
}

/**
 * A base branch and a feature branch, plus a submodule checked out at `sub`.
 *
 * The submodule repository has two commits, so a case can move its HEAD back
 * one and give the parent a gitlink change. `protocol.file.allow` has to be
 * turned on for this one command, because git refuses to clone a submodule over
 * a plain path by default.
 */
function submoduleRepo(name) {
  const inner = newRepo(`${name}-inner`);
  put(inner, "lib.txt", lines("inner", 5));
  commitAll(inner, "inner one");
  put(inner, "lib.txt", lines("inner", 6));
  commitAll(inner, "inner two");

  const dir = newRepo(name);
  put(dir, "src/app.js", lines("base", 20));
  commitAll(dir, "base commit");
  gitAt(dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub"]);
  commitAll(dir, "add the submodule");
  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  put(dir, "src/new.js", lines("new", 40));
  commitAll(dir, "feature work");
  return dir;
}

/**
 * One repository holding every diff record type worth worrying about: a
 * deletion, an addition, a binary change, a binary addition, a binary deletion,
 * a pure rename, a mode-only change, a quoted non-ASCII path, a path with a
 * space, CRLF content, and a file with no final newline on either side.
 *
 * The added and the deleted binary are the two sections git writes with no
 * `---` and `+++` pair, so the side that does not exist can only be read back
 * out of the `diff --git` line.
 */
function zooRepo(name) {
  const dir = newRepo(name);
  put(dir, "src/plain.txt", lines("plain", 30));
  put(dir, "src/mode.sh", "#!/bin/sh\necho hello\n");
  put(dir, "src/rename me.txt", lines("moved", 5));
  put(dir, "src/data.bin", Buffer.from([0, 1, 2, 3, 0, 255, 7]));
  put(dir, "src/removed.bin", Buffer.from([0, 4, 4, 4, 0, 254, 8]));
  put(dir, "src/no-newline.txt", "alpha\nomega-old");
  put(dir, "src/café.txt", "coffee\n");
  put(dir, "src/with space.txt", "spaced\n");
  put(dir, "src/deleted.txt", lines("gone", 4));
  put(dir, "src/crlf.txt", "one\r\ntwo\r\nthree\r\n");
  commitAll(dir, "base commit");

  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  put(dir, "src/plain.txt", `${lines("plain", 10)}${lines("edited", 4)}${lines("plain", 16, 15)}`);
  chmodSync(join(dir, "src/mode.sh"), 0o755);
  gitAt(dir, ["mv", "src/rename me.txt", "src/renamed.txt"]);
  put(dir, "src/data.bin", Buffer.from([0, 9, 9, 9, 0, 1, 2, 3]));
  put(dir, "src/no-newline.txt", "alpha\nomega-new");
  put(dir, "src/café.txt", "coffee and cake\n");
  put(dir, "src/with space.txt", "spaced twice\n");
  del(dir, "src/deleted.txt");
  put(dir, "src/crlf.txt", "one\r\nTWO\r\nthree\r\n");
  put(dir, "src/added.txt", lines("fresh feature line", 6));
  put(dir, "src/added.bin", Buffer.from([0, 7, 7, 7, 0, 253, 9]));
  del(dir, "src/removed.bin");
  commitAll(dir, "every record type");
  return dir;
}

/**
 * Files that really live in top-level `a/` and `b/` folders: a pure rename
 * inside `b/`, a rename with an edit inside `a/` whose old name holds a space,
 * and a copy out of `a/` into `b/`.
 *
 * Git writes `rename from`, `rename to`, `copy from`, and `copy to` with the
 * plain repository path and no side prefix, so these are the names a parser
 * shortens if it strips one from those lines.
 *
 * The copy only shows with `--find-copies-harder`, because its source is
 * unchanged. The CLI asks for renames alone, so through `prep` the copy is a
 * plain addition.
 */
function sidePrefixRepo(name) {
  const dir = newRepo(name);
  put(dir, "a/edit me.txt", lines("edit", 20));
  put(dir, "a/source.txt", lines("source", 6));
  put(dir, "b/orig.txt", lines("kept", 6));
  commitAll(dir, "base commit");

  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  gitAt(dir, ["mv", "a/edit me.txt", "a/edited.txt"]);
  put(dir, "a/edited.txt", `${lines("edit", 10)}CHANGED\n${lines("edit", 9, 12)}`);
  gitAt(dir, ["mv", "b/orig.txt", "b/moved.txt"]);
  put(dir, "b/copy.txt", lines("source", 6));
  commitAll(dir, "renames under a/ and b/");
  return dir;
}

/**
 * Everything git can do to content on its way out of the object store: CRLF
 * endings from a `text eol=crlf` attribute, a UTF-16 working tree from
 * `working-tree-encoding`, a smudge filter that replaces the body and leaves a
 * witness file behind, and a second filter marked `required` whose command does
 * not exist. It also holds an executable file and a symlink, because both are
 * part of a snapshot the reviewer has to trust.
 *
 * `git checkout-index` applies every one of those. The stored bytes are what
 * `git diff` compares, so the snapshot must hold the stored bytes.
 */
function conversionRepo(name, witness) {
  const dir = newRepo(name);
  gitAt(dir, ["config", "filter.witness.clean", "cat"]);
  gitAt(dir, ["config", "filter.witness.smudge", `sh -c 'printf ran > ${witness}; printf REPLACED'`]);
  gitAt(dir, ["config", "filter.absent.clean", "cat"]);
  gitAt(dir, ["config", "filter.absent.smudge", "code-review-selftest-no-such-command"]);
  gitAt(dir, ["config", "filter.absent.required", "true"]);
  put(
    dir,
    ".gitattributes",
    "*.crlf text eol=crlf\n*.u16 working-tree-encoding=UTF-16LE\n*.smudged filter=witness\n*.strict filter=absent\n",
  );
  put(dir, "src/win.crlf", "one\r\ntwo\r\n");
  put(dir, "src/wide.u16", Buffer.from("hello\nwide\n", "utf16le"));
  put(dir, "src/body.smudged", "stored body\n");
  put(dir, "src/keep.strict", "strict body\n");
  put(dir, "src/run.sh", "#!/bin/sh\necho base\n");
  chmodSync(join(dir, "src/run.sh"), 0o755);
  symlinkSync("run.sh", join(dir, "src/link"));
  commitAll(dir, "base commit");

  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  put(dir, "src/win.crlf", "one\r\nTWO\r\n");
  put(dir, "src/body.smudged", "stored body\nand more\n");
  commitAll(dir, "feature work");
  return dir;
}

/** `[{ mode, type, oid, path }]` for every entry of a tree, paths included. */
function treeEntries(dir, tree) {
  const listing = gitAt(dir, ["ls-tree", "-r", "-z", "--full-tree", tree]).stdout;
  return listing
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const [meta, path] = record.split("\t");
      const [mode, type, oid] = meta.split(" ");
      return { mode, type, oid, path };
    });
}

/** "caf<0xE9> latin1": a Latin-1 or CP1252 source line git still calls text. */
const LATIN1_WORD = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
const REPLACEMENT = Buffer.from("\uFFFD");
/** The octal escape git writes for 中 when `core.quotepath` is on. */
const CHINESE_OCTAL = Buffer.from("\\344\\270\\255");

/**
 * Names the parser has to hand back as text: four scripts, a space beside an
 * emoji so the unquoted `diff --git` line is ambiguous, and a tab that git
 * quotes whatever `core.quotepath` says. The binary file has no `---` and `+++`
 * pair, so its path can only come from the `diff --git` line.
 */
const ODD_NAMES = [
  "src/latin1.txt",
  "src/🚀 rocket.txt",
  "src/中文.txt",
  "src/日本語.txt",
  "src/한국어.txt",
  "src/tab\there.txt",
  "src/データ file.dat",
];

/** A diff holding a byte that is not valid UTF-8, and the names above. */
function encodingRepo(name, { quotePath }) {
  const dir = newRepo(name);
  gitAt(dir, ["config", "core.quotepath", quotePath ? "true" : "false"]);
  put(dir, "src/latin1.txt", "base\n");
  put(dir, "src/データ file.dat", Buffer.from([0, 1, 2, 3, 0, 255, 7]));
  commitAll(dir, "base commit");

  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  put(dir, "src/latin1.txt", Buffer.concat([Buffer.from("base\n"), LATIN1_WORD, Buffer.from(" latin1\n")]));
  put(dir, "src/データ file.dat", Buffer.from([0, 9, 9, 9, 0, 1, 2, 3]));
  for (const path of ODD_NAMES) {
    if (path !== "src/latin1.txt" && !path.endsWith(".dat")) put(dir, path, `hello ${basename(path)}\n`);
  }
  commitAll(dir, "one odd byte and several odd names");
  return dir;
}

/**
 * One fixture holding the four things a machine's git config would change:
 * hunks exactly ten lines apart, which `diff.interHunkContext` would merge; a
 * pure rename, which `diff.renames=false` would split into a delete and an
 * add; a non-ASCII name, which `core.quotepath=false` would leave unquoted; and
 * CRLF content, which `core.autocrlf=input` would strip.
 */
function machineRepo(name) {
  const dir = newRepo(name);
  put(dir, "src/blocks.txt", blockText(4, false));
  put(dir, "src/move me.txt", lines("moved", 5));
  put(dir, "src/café.txt", "coffee\n");
  put(dir, "src/crlf.txt", "one\r\ntwo\r\nthree\r\n");
  commitAll(dir, "base commit");

  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  put(dir, "src/blocks.txt", blockText(4, true));
  gitAt(dir, ["mv", "src/move me.txt", "src/moved.txt"]);
  put(dir, "src/café.txt", "coffee and cake\n");
  put(dir, "src/crlf.txt", "one\r\nTWO\r\nthree\r\n");
  commitAll(dir, "feature work");
  return dir;
}

// ---------------------------------------------------------------------------
// Handmade diff fixtures
// ---------------------------------------------------------------------------

/** A new file of `count` added lines: one hunk, `count` changed lines. */
function addedFileDiff(path, count, prefix = "line") {
  let body = "";
  for (let n = 1; n <= count; n += 1) body += `+${prefix} ${n}\n`;
  return (
    `diff --git a/${path} b/${path}\n` +
    "new file mode 100644\n" +
    "index 0000000..1111111\n" +
    "--- /dev/null\n" +
    `+++ b/${path}\n` +
    `@@ -0,0 +1,${count} @@\n${body}`
  );
}

/** A binary file change: no hunks, so no changed lines at all. */
function binaryFileDiff(path) {
  return (
    `diff --git a/${path} b/${path}\n` +
    "index 1111111..2222222 100644\n" +
    `Binary files a/${path} and b/${path} differ\n`
  );
}

/** A modified file of `hunks` insert-only hunks, each adding `perHunk` lines. */
function insertHunksDiff(path, hunks, perHunk) {
  let text =
    `diff --git a/${path} b/${path}\n` +
    "index 1111111..2222222 100644\n" +
    `--- a/${path}\n` +
    `+++ b/${path}\n`;
  let oldAt = 10;
  let newAt = 10;
  for (let hunk = 0; hunk < hunks; hunk += 1) {
    let body = "";
    for (let n = 1; n <= perHunk; n += 1) body += `+hunk ${hunk} line ${n}\n`;
    text += `@@ -${oldAt},0 +${newAt + 1},${perHunk} @@\n${body}`;
    oldAt += 20;
    newAt += 20 + perHunk;
  }
  return text;
}

const CRLF_DIFF =
  "diff --git a/src/win.txt b/src/win.txt\n" +
  "index 1111111..2222222 100644\n" +
  "--- a/src/win.txt\n" +
  "+++ b/src/win.txt\n" +
  "@@ -1,4 +1,4 @@\n" +
  " alpha\r\n" +
  "-beta\r\n" +
  "+BETA\r\n" +
  "\n" +
  " gamma\r\n";

// A patch file under review. Its body holds lines that look like the start of a
// new file section and a new hunk.
const NESTED_DIFF =
  "diff --git a/patches/fix.patch b/patches/fix.patch\n" +
  "index 1111111..2222222 100644\n" +
  "--- a/patches/fix.patch\n" +
  "+++ b/patches/fix.patch\n" +
  "@@ -1,3 +1,3 @@\n" +
  " diff --git a/x.txt b/x.txt\n" +
  "-@@ -1 +1 @@\n" +
  "+@@ -1,2 +1,2 @@\n" +
  " -old\n";

// Two sections whose `diff --git` line cannot be split on the space alone.
const AMBIGUOUS_DIFF =
  "diff --git a/src/my bin file.dat b/src/my bin file.dat\n" +
  "index 1111111..2222222 100644\n" +
  "Binary files a/src/my bin file.dat and b/src/my bin file.dat differ\n" +
  "diff --git a/x b/y.txt b/x b/y.txt\n" +
  "old mode 100644\n" +
  "new mode 100755\n";

// A file start line no rule can split into two paths, which is what a
// repository setting `diff.srcPrefix` and `diff.dstPrefix` would produce if the
// CLI did not pin both keys.
const UNREADABLE_START_DIFF =
  "diff --git i/src/app.js w/src/app.js\n" +
  "index 1111111..2222222 100644\n" +
  "--- i/src/app.js\n" +
  "+++ w/src/app.js\n" +
  "@@ -1,3 +1,3 @@\n" +
  " one\n" +
  "-two\n" +
  "+TWO\n" +
  " three\n";

// A hunk header no rule can read, with a real hunk after it. The counts of the
// bad header are unknown, so its body lines belong to no count at all.
const UNREADABLE_HUNK_DIFF =
  "diff --git a/src/app.js b/src/app.js\n" +
  "index 1111111..2222222 100644\n" +
  "--- a/src/app.js\n" +
  "+++ b/src/app.js\n" +
  "@@@ -1,2 -1,2 +1,2 @@@\n" +
  "@@ -9,3 +9,3 @@\n" +
  " nine\n" +
  "-ten\n" +
  "+TEN\n" +
  " eleven\n";

const COMBINED_DIFF =
  "diff --cc src/merged.txt\n" +
  "index 1111111,2222222..3333333\n" +
  "--- a/src/merged.txt\n" +
  "+++ b/src/merged.txt\n" +
  "@@@ -1,2 -1,2 +1,2 @@@\n" +
  "- one\n" +
  " -two\n" +
  "++three\n";

const BAD_COUNTS_DIFF =
  "diff --git a/src/wrong.txt b/src/wrong.txt\n" +
  "index 1111111..2222222 100644\n" +
  "--- a/src/wrong.txt\n" +
  "+++ b/src/wrong.txt\n" +
  "@@ -1,9 +1,9 @@\n" +
  " one\n" +
  "-two\n" +
  "+TWO\n" +
  " three\n";

const COPY_ONLY_DIFF =
  "diff --git a/src/original.txt b/src/copy.txt\n" +
  "similarity index 100%\n" +
  "copy from src/original.txt\n" +
  "copy to src/copy.txt\n";

// ---------------------------------------------------------------------------
// Slice helpers used by several cases
// ---------------------------------------------------------------------------

function fileCounts(manifest) {
  const counts = new Map();
  for (const slice of manifest.slices) {
    for (const file of slice.files) counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
  }
  return counts;
}

const sliceTotal = (manifest) => manifest.slices.reduce((sum, slice) => sum + slice.changed, 0);

/**
 * Read every written slice back and prove the slices hold each file section of
 * `full.diff` exactly once, byte for byte.
 *
 * Slice order is not the order of the file: a slice is placed by its first
 * file, so a later fragment of a big file can sit in an earlier slice. So the
 * fragments are put back in the order the diff has them, which is what
 * `manifest.json` records, and only then compared.
 */
function checkRebuild(check, runDir, manifest, label) {
  const diff = parseDiff(readDiff(join(runDir, "full.diff")));
  const original = new Map(diff.files.map((file) => [file.path, file]));
  const found = new Map();
  for (const slice of manifest.slices) {
    const parsed = parseDiff(readDiff(join(runDir, slice.path)));
    check.none(checkParse(parsed), `${label}: ${slice.id} does not parse cleanly`);
    for (const file of parsed.files) {
      const record = found.get(file.path) ?? { header: file.header, hunks: [] };
      check.eq(file.header, record.header, `${label}: ${file.path} header differs between fragments`);
      record.hunks.push(...file.hunks);
      found.set(file.path, record);
    }
  }

  for (const [path, record] of found) {
    const wanted = original.get(path);
    if (!wanted) {
      check.fail(`${label}: ${path} is in a slice but not in full.diff`);
      continue;
    }
    check.eq(record.header, wanted.header, `${label}: ${path} file header`);
    // Hunk text back to its place in the file, so a hunk that was altered on
    // the way out has no place to match.
    const places = new Map();
    for (const [at, hunk] of wanted.hunks.entries()) {
      const list = places.get(hunk.text) ?? [];
      list.push(at);
      places.set(hunk.text, list);
    }
    const pairs = [];
    for (const hunk of record.hunks) {
      const list = places.get(hunk.text) ?? [];
      const at = list.length > 0 ? list.shift() : -1;
      if (at === -1) check.fail(`${label}: ${path}: "${hunk.headerLine}" is not a hunk of full.diff`);
      pairs.push({ at, text: hunk.text });
    }
    pairs.sort((left, right) => left.at - right.at);
    check.deep(
      pairs.map((pair) => pair.at),
      wanted.hunks.map((_, at) => at),
      `${label}: ${path} hunk coverage`,
    );
    check.eq(
      record.header + pairs.map((pair) => pair.text).join(""),
      wanted.text,
      `${label}: ${path} does not rebuild from its slices`,
    );
  }
  check.eq(found.size, diff.files.length, `${label}: slice file count`);
  return diff;
}

/**
 * Every slice must undo cleanly against the merged source snapshot. That is an
 * independent witness that the fragments are real patches, not just text we cut
 * up. Binary sections are skipped: `git apply` refuses them without a full
 * index line, which a diff without `--binary` never carries.
 */
function checkReverseApply(check, runDir, manifest, label) {
  let checked = 0;
  for (const slice of manifest.slices) {
    if (slice.files.some((file) => file.binary)) continue;
    const args = ["apply", "-R", "--check", "-p1", join(runDir, slice.path)];
    const result = gitAt(manifest.sourceDir, args, { allowFail: true });
    check.eq(result.code, 0, `${label}: ${slice.id} does not reverse-apply (${clip(result.stderr)})`);
    checked += 1;
  }
  check.ok(checked > 0, `${label}: no slice was reverse-applied`);
}

function sliceFilesOnDisk(runDir) {
  const dir = join(runDir, "slices");
  return existsSync(dir) ? readdirSync(dir).sort() : null;
}

/**
 * The manifest on disk against the manifest on stdout. `SKILL.md` says the
 * printed JSON *is* `manifest.json`, and `split` builds one object and puts it
 * through a single `JSON.stringify`, so a whole-object comparison is both
 * correct and cheap. Comparing `sliceCount` alone passed a file whose every
 * slice `path` was wrong and whose `batches` was empty, which is a manifest
 * that sends an agent to slice files that do not exist.
 *
 * The file is read as `<runDir>/manifest.json` rather than through the printed
 * `manifestFile`, so that pointer has to name the file that was written.
 */
function checkManifestFile(check, runDir, manifest, label) {
  const at = join(runDir, "manifest.json");
  check.eq(manifest.manifestFile, at, `${label}: manifestFile names the written manifest`);
  let text = "";
  try {
    text = readFileSync(at, "utf8");
  } catch (error) {
    check.fail(`${label}: ${at} cannot be read: ${error.message}`);
    return;
  }
  try {
    check.deep(JSON.parse(text), manifest, `${label}: manifest.json matches stdout`);
  } catch {
    check.fail(`${label}: manifest.json is not one JSON object: ${clip(text)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture isolation
// ---------------------------------------------------------------------------

/** Config that would break cases which have nothing to do with it. */
const MACHINE_CONFIG =
  "[diff]\n" +
  "\trenames = false\n" +
  "\tinterHunkContext = 20\n" +
  "\tnoprefix = true\n" +
  "\texternal = /bin/false\n" +
  "[core]\n" +
  "\tquotepath = false\n" +
  "\tautocrlf = input\n" +
  "\thooksPath = /code-review-selftest-no-such-hooks\n" +
  "[user]\n" +
  "\tname = Machine Owner\n" +
  "\temail = owner@example.invalid\n" +
  "[commit]\n" +
  "\tgpgsign = true\n";

/** A template whose pre-commit hook fails, to prove `GIT_TEMPLATE_DIR` is dropped. */
function machineTemplate() {
  const template = join(WORK, "machine-template");
  const hook = join(template, "hooks", "pre-commit");
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\necho the machine's hook ran >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  return template;
}

// Every case below stands on the promise that a fixture sees nothing but its
// own local config. This one breaks that promise on purpose: it puts hostile
// config in files, in `GIT_CONFIG_KEY_<n>` pairs, in a commit hook template,
// and in a git folder and object store pointing elsewhere, all in this
// process's own environment, which both spawn helpers inherit from.
//
// `GIT_ENV` does not drop `GIT_EXTERNAL_DIFF`, and nothing drops
// `diff.external`: an external driver is refused by the `--no-ext-diff` in the
// CLI's own diff flags, which is why a case must read a fixture diff through
// `protectedDiff`.
test("harness: the machine's git config and environment cannot reach a fixture", (check) => {
  const config = join(WORK, "machine.gitconfig");
  writeFileSync(config, MACHINE_CONFIG);
  const hostile = {
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "diff.interHunkContext",
    GIT_CONFIG_VALUE_0: "20",
    GIT_EXTERNAL_DIFF: "/bin/false",
    GIT_TEMPLATE_DIR: machineTemplate(),
    GIT_DIR: join(WORK, "machine-elsewhere.git"),
    GIT_WORK_TREE: join(WORK, "machine-elsewhere"),
    GIT_INDEX_FILE: join(WORK, "machine-elsewhere.index"),
    GIT_OBJECT_DIRECTORY: join(WORK, "machine-objects"),
  };
  const saved = new Map(Object.keys(hostile).map((key) => [key, process.env[key]]));
  Object.assign(process.env, hostile);

  try {
    const dir = machineRepo("machine-hostile");
    const setting = (key) => gitAt(dir, ["config", "--get", key], { allowFail: true }).stdout.trim();
    const machineKeys = [
      "diff.renames",
      "diff.interHunkContext",
      "diff.noprefix",
      "diff.external",
      "core.quotepath",
      "core.hooksPath",
    ];
    for (const key of machineKeys) {
      check.eq(setting(key), "", `${key} does not reach the fixture`);
    }
    check.eq(setting("user.name"), "Code Review Self Test", "the fixture's own identity wins");
    check.eq(setting("core.autocrlf"), "false", "the fixture's own core.autocrlf wins");
    check.eq(gitOut(dir, ["rev-parse", "--git-dir"]), ".git", "the fixture uses its own git folder");
    for (const stray of ["machine-elsewhere.git", "machine-elsewhere", "machine-elsewhere.index", "machine-objects"]) {
      check.eq(existsSync(join(WORK, stray)), false, `nothing was written to ${stray}`);
    }

    const text = protectedDiff(dir, ["-U10", "master", "feature"], { encoding: "latin1" });
    const parsed = parseDiff(text);
    check.none(checkParse(parsed), "checkParse");
    check.has(text, "diff --git a/src/blocks.txt b/src/blocks.txt", "the a/ and b/ prefixes survive");
    check.has(text, "caf\\303\\251", "the quoted-path coverage survives");
    const byPath = new Map(parsed.files.map((file) => [file.path, file]));
    check.eq(byPath.get("src/blocks.txt")?.hunks.length, 4, "hunks ten lines apart stay apart");
    check.eq(byPath.get("src/moved.txt")?.status, "R", "the rename is still a rename");
    check.eq(byPath.get("src/moved.txt")?.oldPath, "src/move me.txt", "the rename old path");
    check.has(byPath.get("src/crlf.txt")?.text ?? "", "+TWO\r\n", "the carriage returns survive");

    // The CLI is a child of this process, so it inherits the same environment.
    const before = snapshot(dir);
    const out = jsonOut(check, review(dir, ["prep"]), "prep");
    unchanged(check, before, snapshot(dir), "prep under the machine's environment");
    if (!out) return;
    check.eq(out.totalChanged, parsed.totals.changed, "the reported total is the total in the protected diff");
    check.deep(
      out.files.map((file) => `${file.path}:${file.status}`).sort(),
      parsed.files.map((file) => `${file.path}:${file.status}`).sort(),
      "the reported records are the records in the protected diff",
    );
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ---------------------------------------------------------------------------
// diff.mjs cases
// ---------------------------------------------------------------------------

test("diff: every record type of a real git diff", (check) => {
  const dir = zooRepo("diff-zoo");
  const text = protectedDiff(dir, ["-U10", "master", "feature"], { encoding: "latin1" });
  const parsed = parseDiff(text);

  check.deep(parsed.warnings, [], "warnings");
  check.none(checkParse(parsed), "checkParse");
  check.eq(parsed.files.length, 12, "file sections");
  check.eq(parsed.preamble, "", "preamble");
  check.eq(parsed.preamble + parsed.files.map((file) => file.text).join(""), text, "records rebuild the diff");

  const byPath = new Map(parsed.files.map((file) => [file.path, file]));
  const status = (path) => byPath.get(path)?.status;
  check.eq(status("src/added.txt"), "A", "added status");
  check.eq(status("src/deleted.txt"), "D", "deleted status");
  check.eq(status("src/renamed.txt"), "R", "rename status");
  check.eq(status("src/plain.txt"), "M", "plain status");
  check.eq(byPath.get("src/renamed.txt")?.oldPath, "src/rename me.txt", "rename old path");
  check.eq(byPath.get("src/renamed.txt")?.renameOnly, true, "rename holds no hunks");
  check.eq(byPath.get("src/data.bin")?.binary, true, "binary flag");
  check.eq(byPath.get("src/data.bin")?.changed, 0, "binary changed lines");
  check.eq(byPath.get("src/mode.sh")?.modeOnly, true, "mode-only flag");
  check.eq(byPath.get("src/deleted.txt")?.newPath, null, "deleted new path");
  check.eq(byPath.get("src/added.txt")?.oldPath, null, "added old path");
  // A section with no `---` and `+++` pair takes both paths from one line that
  // names both sides, so this is where a fresh file used to claim an old path.
  check.eq(status("src/added.bin"), "A", "added binary status");
  check.eq(status("src/removed.bin"), "D", "deleted binary status");
  check.eq(byPath.get("src/added.bin")?.oldPath, null, "an added binary has no old side");
  check.eq(byPath.get("src/added.bin")?.newPath, "src/added.bin", "the added binary keeps its new side");
  check.eq(byPath.get("src/removed.bin")?.newPath, null, "a deleted binary has no new side");
  check.eq(byPath.get("src/removed.bin")?.oldPath, "src/removed.bin", "the deleted binary keeps its old side");
  check.ok(byPath.has("src/with space.txt"), `path with a space: ${clip([...byPath.keys()].join(", "))}`);
  check.ok(byPath.has("src/café.txt"), `quoted non-ASCII path: ${clip([...byPath.keys()].join(", "))}`);

  const noNewline = byPath.get("src/no-newline.txt");
  check.eq(noNewline?.hunks.length, 1, "no-newline hunks");
  check.eq((noNewline?.text.match(/\\ No newline at end of file/g) ?? []).length, 2, "no-newline markers");
  check.has(byPath.get("src/crlf.txt")?.text ?? "", "TWO\r\n", "CRLF content survives the parse");

  for (const file of parsed.files) {
    check.eq(fileFragment(file), file.text, `${file.path}: whole-file fragment`);
  }

  // Cross-check the counts against git rather than against ourselves.
  let counted = 0;
  for (const line of protectedDiff(dir, ["--numstat", "master", "feature"]).split("\n")) {
    const found = /^(\d+)\t(\d+)\t/.exec(line);
    if (found) counted += Number(found[1]) + Number(found[2]);
  }
  check.eq(parsed.totals.changed, counted, "changed lines against git numstat");
});

test("diff: unquotePath undoes git quoting", (check) => {
  check.eq(unquotePath("a/src/plain.txt"), "a/src/plain.txt", "plain path");
  check.eq(unquotePath("a/src/with space.txt\t"), "a/src/with space.txt", "trailing tab");
  check.eq(unquotePath('"a/src/caf\\303\\251.txt"'), "a/src/café.txt", "octal UTF-8");
  check.eq(unquotePath('"a/x\\"y\\\\z\\t.txt"'), 'a/x"y\\z\t.txt', "quote, backslash, and tab escapes");
  // `core.quotepath=false` leaves the UTF-8 bytes of a name raw, quoted or not,
  // and the input is one character per byte, so "\u00c3\u00a9" is the é of café.
  check.eq(unquotePath("a/src/caf\u00c3\u00a9.txt"), "a/src/café.txt", "raw UTF-8 bytes, unquoted");
  check.eq(unquotePath('"a/src/caf\u00c3\u00a9 \\"q\\".txt"'), 'a/src/café "q".txt', "raw UTF-8 bytes, quoted");
});

test("diff: CRLF body and an empty body line", (check) => {
  const parsed = parseDiff(CRLF_DIFF);
  check.eq(parsed.files.length, 1, "file sections");
  check.none(checkParse(parsed), "checkParse");
  check.eq(parsed.warnings.length, 1, `warnings: ${clip(parsed.warnings.join(" | "))}`);
  check.has(parsed.warnings[0] ?? "", "empty body line(s) read as context lines", "empty-line warning");
  check.has(parsed.files[0].text, "+BETA\r\n", "carriage returns survive");
  check.eq(parsed.totals.changed, 2, "changed lines");
  check.eq(parsed.files[0].hunks[0].context, 3, "context lines, the empty one included");
});

test("diff: a hunk body holding diff and hunk lines", (check) => {
  const parsed = parseDiff(NESTED_DIFF);
  check.eq(parsed.files.length, 1, "one file section, not three");
  check.eq(parsed.files[0].hunks.length, 1, "one hunk");
  check.eq(parsed.files[0].path, "patches/fix.patch", "path");
  check.none(checkParse(parsed), "checkParse");
  check.eq(parsed.totals.changed, 2, "changed lines");
});

test("diff: ambiguous unquoted file start lines", (check) => {
  const parsed = parseDiff(AMBIGUOUS_DIFF);
  check.deep(parsed.warnings, [], "warnings");
  check.none(checkParse(parsed), "checkParse");
  check.eq(parsed.files.length, 2, "file sections");
  check.eq(parsed.files[0].path, "src/my bin file.dat", "binary path with a space");
  check.eq(parsed.files[0].binary, true, "binary flag");
  check.eq(parsed.files[1].path, "x b/y.txt", "path holding a b/ pair");
  check.eq(parsed.files[1].modeOnly, true, "mode-only flag");

  // A record with no hunks still has to reach exactly one slice.
  const plan = planSlices({ files: parsed.files, target: 10 });
  check.none(checkPlan(parsed, plan), "checkPlan");
});

test("diff: an unreadable file start line is a problem, not a warning", (check) => {
  const parsed = parseDiff(UNREADABLE_START_DIFF);
  check.eq(parsed.files.length, 1, "file sections");
  check.deep(parsed.warnings, [], "warnings");
  check.eq(parsed.files[0].pathsUnreadable, true, "pathsUnreadable");
  // The `---` and `+++` lines still answer, but with prefixes no file has, so
  // the paths must not be trusted.
  check.eq(parsed.files[0].path, "w/src/app.js", "the guessed path keeps the odd prefix");
  const problems = checkParse(parsed);
  check.eq(problems.length, 1, `problems: ${clip(problems.join(" | "))}`);
  check.has(problems[0] ?? "", "could not read the paths from: diff --git i/src/app.js w/src/app.js", "problem wording");
});

test("diff: an unreadable hunk header is a problem, not a warning", (check) => {
  const parsed = parseDiff(UNREADABLE_HUNK_DIFF);
  check.eq(parsed.files.length, 1, "file sections");
  check.deep(parsed.warnings, [], "warnings");
  check.eq(parsed.files[0].hunks.length, 2, "hunks");
  check.eq(parsed.files[0].hunks[0].headerUnreadable, true, "headerUnreadable on the bad hunk");
  check.eq(parsed.files[0].hunks[1].headerUnreadable, false, "headerUnreadable on the good hunk");
  // The bad header promises nothing, so its counts agree with each other and
  // the count check cannot catch it.
  check.eq(parsed.files[0].hunks[0].countedOld, parsed.files[0].hunks[0].oldLines, "old counts agree");
  check.eq(parsed.files[0].hunks[0].countedNew, parsed.files[0].hunks[0].newLines, "new counts agree");
  const problems = checkParse(parsed);
  check.eq(problems.length, 1, `problems: ${clip(problems.join(" | "))}`);
  check.has(problems[0] ?? "", "src/app.js: unreadable hunk header: @@@ -1,2 -1,2 +1,2 @@@", "problem wording");
});

test("diff: a truncated diff with no final newline", (check) => {
  const text = addedFileDiff("src/cut.txt", 5).replace(/\n$/, "");
  const parsed = parseDiff(text);
  check.none(checkParse(parsed), "checkParse");
  check.eq(parsed.files.map((file) => file.text).join(""), text, "records rebuild the diff");
  check.eq(parsed.totals.changed, 5, "changed lines");
});

test("diff: a combined diff is reported, not ignored", (check) => {
  const parsed = parseDiff(COMBINED_DIFF);
  check.eq(parsed.files.length, 0, "no file sections, because diff --cc is not diff --git");
  const problems = checkParse(parsed);
  check.ok(problems.length > 0, "checkParse must report the content it cannot slice");
  check.has(problems.join(" | "), 'diff content before the first "diff --git" line', "problem wording");
});

test("diff: wrong hunk header counts are reported", (check) => {
  const parsed = parseDiff(BAD_COUNTS_DIFF);
  const problems = checkParse(parsed);
  check.ok(problems.length > 0, "checkParse must report the mismatch");
  check.has(problems.join(" | "), "promises 9 old and 9 new lines", "problem wording");
});

test("diff: an empty diff plans zero slices", (check) => {
  const parsed = parseDiff("");
  check.eq(parsed.files.length, 0, "file sections");
  check.eq(parsed.totals.changed, 0, "changed lines");
  check.none(checkParse(parsed), "checkParse");
  const plan = planSlices({ files: parsed.files, target: 800 });
  check.eq(plan.sliceCount, 0, "slice count");
  check.deep(plan.batches, [], "batches");
  check.none(checkPlan(parsed, plan), "checkPlan");
});

test("diff: three equal units of 500 need three slices at target 800", (check) => {
  const text = addedFileDiff("src/a.txt", 500) + addedFileDiff("src/b.txt", 500) + addedFileDiff("src/c.txt", 500);
  const parsed = parseDiff(text);
  const plan = planSlices({ files: parsed.files, target: 800 });
  check.none(checkParse(parsed), "checkParse");
  check.none(checkPlan(parsed, plan), "checkPlan");
  check.eq(plan.sliceCount, 3, "slice count: overfilling two slices is the fault this catches");
  check.eq(plan.oversized, false, "oversized");
  for (const slice of plan.slices) check.eq(slice.changed, 500, `${slice.id} changed lines`);
});

test("diff: equally empty slices are broken by folder, and balance still wins", (check) => {
  const tie = parseDiff(
    addedFileDiff("a/large.txt", 600) + addedFileDiff("x/large.txt", 600) + addedFileDiff("x/small.txt", 200),
  );
  const tiePlan = planSlices({ files: tie.files, target: 1000 });
  check.none(checkParse(tie), "checkParse");
  check.none(checkPlan(tie, tiePlan), "checkPlan");
  check.deep(
    tiePlan.slices.map((slice) => slice.parts.map((part) => part.file.path)),
    [["a/large.txt"], ["x/large.txt", "x/small.txt"]],
    "the two x/ files share a slice",
  );
  check.deep(
    tiePlan.slices.map((slice) => slice.changed),
    [600, 800],
    "the same sizes the folder-blind packer gave",
  );

  // Folder affinity only settles a tie. A fuller same-folder slice has to lose
  // to an emptier slice from another folder, or balance is sacrificed for it.
  const uneven = parseDiff(
    addedFileDiff("x/big.txt", 700) + addedFileDiff("b/mid.txt", 500) + addedFileDiff("x/tiny.txt", 100),
  );
  const unevenPlan = planSlices({ files: uneven.files, target: 1000 });
  check.none(checkPlan(uneven, unevenPlan), "checkPlan on the uneven fixture");
  check.deep(
    unevenPlan.slices.map((slice) => slice.parts.map((part) => part.file.path)),
    [["x/big.txt"], ["b/mid.txt", "x/tiny.txt"]],
    "the emptier slice beats the one sharing the folder",
  );
  check.deep(unevenPlan.slices.map((slice) => slice.changed), [700, 600], "balance is kept");
});

test("diff: zero-line sections spread across slices, and count beats folder", (check) => {
  let text = addedFileDiff("src/a.txt", 800) + addedFileDiff("src/b.txt", 600) + addedFileDiff("src/c.txt", 800);
  for (let n = 1; n <= 8; n += 1) text += binaryFileDiff(`assets/img-${n}.dat`);
  const spread = parseDiff(text);
  const spreadPlan = planSlices({ files: spread.files, target: 1000 });
  check.none(checkParse(spread), "checkParse");
  check.none(checkPlan(spread, spreadPlan), "checkPlan");
  check.deep(
    spreadPlan.slices.map((slice) => slice.parts.length),
    [4, 3, 4],
    "the eight binary sections are shared out, not piled into the emptiest slice",
  );
  check.deep(spreadPlan.slices.map((slice) => slice.changed), [800, 600, 800], "changed lines are untouched");

  // Same rule as for changed lines: load first, folder only on a tie. The first
  // zero unit joins the slice sharing its folder, the second has to go to a
  // slice holding no zero unit yet.
  const tie = parseDiff(
    addedFileDiff("a/big.txt", 600) +
      addedFileDiff("b/big.txt", 600) +
      addedFileDiff("c/big.txt", 600) +
      binaryFileDiff("c/one.bin") +
      binaryFileDiff("c/two.bin"),
  );
  const tiePlan = planSlices({ files: tie.files, target: 1000 });
  check.none(checkPlan(tie, tiePlan), "checkPlan on the tie fixture");
  check.deep(
    tiePlan.slices.map((slice) => slice.parts.map((part) => part.file.path)),
    [["a/big.txt", "c/two.bin"], ["b/big.txt"], ["c/big.txt", "c/one.bin"]],
    "folder settles the first, an empty slice takes the second",
  );
});

test("diff: seven files at target 100 give seven slices in three batches", (check) => {
  let text = "";
  for (let n = 1; n <= 7; n += 1) text += addedFileDiff(`src/file-${n}.txt`, 100);
  const parsed = parseDiff(text);
  const plan = planSlices({ files: parsed.files, target: 100 });
  check.none(checkPlan(parsed, plan), "checkPlan");
  check.eq(plan.sliceCount, 7, "slice count");
  check.deep(
    plan.slices.map((slice) => slice.id),
    ["slice-01", "slice-02", "slice-03", "slice-04", "slice-05", "slice-06", "slice-07"],
    "zero-padded ids in diff order",
  );
  check.deep(
    plan.slices.map((slice) => slice.parts[0].file.path),
    parsed.files.map((file) => file.path),
    "slices follow diff order",
  );
  check.deep(
    plan.batches,
    [
      ["slice-01", "slice-02", "slice-03"],
      ["slice-04", "slice-05", "slice-06"],
      ["slice-07"],
    ],
    `batches of at most ${MAX_BATCH}`,
  );

  const described = describePlan(plan);
  check.eq(described.batchSize, MAX_BATCH, "manifest batch size");
  check.eq(described.totalChanged, 700, "manifest total");
  check.deep(
    described.slices[0].files,
    [{ path: "src/file-1.txt", oldPath: null, status: "A", binary: false, changed: 100, hunks: 1, ofHunks: 1, partial: false }],
    "manifest file entry",
  );
  check.eq(sliceText(plan.slices[0]), parsed.files[0].text, "slice text");
});

test("diff: one oversized hunk keeps its own slice", (check) => {
  const text = addedFileDiff("src/huge.txt", 1000) + addedFileDiff("src/small.txt", 50);
  const parsed = parseDiff(text);
  const plan = planSlices({ files: parsed.files, target: 800 });
  check.none(checkPlan(parsed, plan), "checkPlan");
  check.eq(plan.oversized, true, "plan oversized");
  check.eq(plan.sliceCount, 2, "slice count");
  check.eq(plan.slices[0].changed, 1000, "the oversized hunk is kept whole");
  check.eq(plan.slices[0].oversized, true, "slice 1 oversized");
  check.eq(plan.slices[0].parts.length, 1, "the oversized hunk sits alone");
  check.eq(plan.slices[1].oversized, false, "slice 2 oversized");
  check.eq(plan.slices[1].changed, 50, "slice 2 changed lines");
});

test("diff: a target of 1 still passes, a target of 0 throws", (check) => {
  const parsed = parseDiff(addedFileDiff("src/a.txt", 20) + addedFileDiff("src/b.txt", 20));
  const plan = planSlices({ files: parsed.files, target: 1 });
  check.none(checkPlan(parsed, plan), "checkPlan at target 1");
  check.eq(plan.sliceCount, 2, "one slice per oversized hunk");
  check.eq(plan.oversized, true, "oversized");
  check.threw(() => planSlices({ files: parsed.files, target: 0 }), RangeError, "target 0");
  check.threw(() => planSlices({ files: parsed.files, target: -5 }), RangeError, "target -5");
});

test("diff: a big file is cut at hunk boundaries only", (check) => {
  const parsed = parseDiff(insertHunksDiff("src/big.txt", 100, 20));
  const plan = planSlices({ files: parsed.files, target: 800 });
  check.none(checkParse(parsed), "checkParse");
  check.none(checkPlan(parsed, plan), "checkPlan");
  check.eq(parsed.files[0].hunks.length, 100, "hunks in the file");
  check.eq(parsed.totals.changed, 2000, "changed lines");
  check.eq(plan.sliceCount, 3, "slice count");
  check.deep(plan.slices.map((slice) => slice.changed), [800, 800, 400], "slice sizes");

  const seen = [];
  for (const slice of plan.slices) {
    check.eq(slice.parts.length, 1, `${slice.id} parts`);
    check.eq(slice.parts[0].partial, true, `${slice.id} is a fragment of the file`);
    for (const hunk of slice.parts[0].hunks) seen.push(hunk.index);
  }
  check.deep(seen, [...Array(100).keys()], "every hunk once, in order");

  const described = describePlan(plan);
  check.eq(described.slices[0].files[0].newLineRanges?.length, 40, "one line range per hunk");
});

test("diff: a copy-only section lands in exactly one slice", (check) => {
  const parsed = parseDiff(COPY_ONLY_DIFF + addedFileDiff("src/other.txt", 30));
  check.deep(parsed.warnings, [], "warnings");
  check.none(checkParse(parsed), "checkParse");
  check.eq(parsed.files[0].status, "C", "copy status");
  check.eq(parsed.files[0].oldPath, "src/original.txt", "copy source");
  check.eq(parsed.files[0].path, "src/copy.txt", "copy target");
  check.eq(parsed.files[0].renameOnly, true, "no hunks");
  const plan = planSlices({ files: parsed.files, target: 10 });
  check.none(checkPlan(parsed, plan), "checkPlan");
  const holders = plan.slices.filter((slice) => slice.parts.some((part) => part.file.path === "src/copy.txt"));
  check.eq(holders.length, 1, "slices holding the copy-only section");
});

// The rename and copy header lines are the one place in a diff that carries no
// side prefix, so a file that really lives in a top-level `a/` or `b/` folder
// is where stripping one loses the folder.
test("diff: a rename or copy line keeps the whole path", (check) => {
  const dir = sidePrefixRepo("diff-side-prefix");
  const text = protectedDiff(dir, ["--find-copies-harder", "master", "feature"]);
  check.has(text, "\nrename from b/orig.txt\n", "git names the rename source with no side prefix");
  check.has(text, "\ncopy from a/source.txt\n", "git names the copy source with no side prefix");

  const parsed = parseDiff(text);
  check.deep(parsed.warnings, [], "warnings");
  check.none(checkParse(parsed), "checkParse");

  const byPath = new Map(parsed.files.map((file) => [file.path, file]));
  check.deep([...byPath.keys()].sort(), ["a/edited.txt", "b/copy.txt", "b/moved.txt"], "paths");
  check.eq(byPath.get("b/moved.txt")?.status, "R", "rename status");
  check.eq(byPath.get("b/moved.txt")?.oldPath, "b/orig.txt", "a pure rename inside b/");
  check.eq(byPath.get("b/copy.txt")?.status, "C", "copy status");
  check.eq(byPath.get("b/copy.txt")?.oldPath, "a/source.txt", "a copy out of a/");
  // This section has `---` and `+++` lines, and those were already right. The
  // rename lines are read after them, so they have to be right as well.
  check.eq(byPath.get("a/edited.txt")?.oldPath, "a/edit me.txt", "a rename with an edit inside a/");
});

// A plan is checked against the records it carries, not against index numbers
// that happen to line up. Both doctored plans below would write a slice holding
// another file's hunk under this file's header.
test("diff: checkPlan reads the records a plan carries", (check) => {
  const parsed = parseDiff(addedFileDiff("src/a.txt", 3) + addedFileDiff("src/b.txt", 3));
  const honest = planSlices({ files: parsed.files, target: 800 });
  check.none(checkParse(parsed), "checkParse");
  check.none(checkPlan(parsed, honest), "checkPlan on the real plan");

  const foreignHunk = planSlices({ files: parsed.files, target: 800 });
  foreignHunk.slices[0].parts[0].hunks = [parsed.files[1].hunks[0]];
  check.has(
    checkPlan(parsed, foreignHunk).join(" | "),
    "src/a.txt: the hunk 0 a slice carries is not this file section's own record",
    "a hunk of another file is reported",
  );

  const foreignFile = planSlices({ files: parsed.files, target: 800 });
  foreignFile.slices[0].parts[0].file = { ...parsed.files[0] };
  check.has(
    checkPlan(parsed, foreignFile).join(" | "),
    "slice-01: a part names file 0, which is not that file section of the diff",
    "a copied file record is reported",
  );

  const twoHunks = parseDiff(insertHunksDiff("src/m.txt", 2, 1));
  const duplicated = planSlices({ files: twoHunks.files, target: 800 });
  duplicated.slices[0].parts[0].hunks = [twoHunks.files[0].hunks[0], twoHunks.files[0].hunks[0]];
  check.has(
    checkPlan(twoHunks, duplicated).join(" | "),
    "src/m.txt: its 2 hunk(s) appear as [0, 0] across the slices",
    "one hunk twice in place of two is reported",
  );
});

test("diff: checkParse reports a section its records do not rebuild", (check) => {
  const shifted = parseDiff(addedFileDiff("src/a.txt", 3));
  shifted.files[0].hunks[0].text = shifted.files[0].hunks[0].text.slice(1);
  check.has(
    checkParse(shifted).join(" | "),
    "src/a.txt: header plus hunks do not rebuild the file section",
    "a hunk that no longer sits at its offset is reported",
  );

  const short = parseDiff(insertHunksDiff("src/m.txt", 2, 1));
  short.files[0].hunks.pop();
  check.has(
    checkParse(short).join(" | "),
    "src/m.txt: header plus hunks do not rebuild the file section",
    "hunks that stop before the end of the section are reported",
  );
});

// ---------------------------------------------------------------------------
// prep cases
// ---------------------------------------------------------------------------

test("prep: a normal branch", (check) => {
  const dir = simpleRepo("prep-normal");
  put(dir, "untracked.txt", "not committed\n");
  const scratch = join(WORK, "prep-normal-tmp");
  mkdirSync(scratch, { recursive: true });

  const before = snapshot(dir);
  const result = review(dir, ["prep"], { TMPDIR: scratch });
  const after = snapshot(dir);
  unchanged(check, before, after, "prep");

  const out = jsonOut(check, result, "prep");
  if (!out) return;
  check.eq(out.baseRef, "master", "baseRef");
  check.eq(out.baseSha, gitOut(dir, ["rev-parse", "refs/heads/master"]), "baseSha");
  check.eq(out.headSha, gitOut(dir, ["rev-parse", "HEAD"]), "headSha");
  check.eq(out.headBranch, "feature", "headBranch");
  check.eq(out.baseBehindTrackingRef, null, "no tracking ref");
  check.eq(out.runDir, realpathSync(join(dir, RUN_ROOT, basename(out.runDir))), "runDir sits in the run root");
  check.eq(out.diffFile, join(out.runDir, "full.diff"), "diffFile");
  check.eq(out.sourceDir, join(out.runDir, "source"), "sourceDir");
  check.eq(out.totalChanged, 40, "totalChanged");
  check.eq(out.massive, false, "massive");
  check.deep(out.contextFiles, ["README.md"], "contextFiles");
  check.eq(out.commits.length, 1, "commit subjects");
  check.ok(out.commits[0].endsWith("feature work"), `commit subject: ${show(out.commits[0])}`);
  check.deep(
    out.files,
    [{ path: "src/new.js", oldPath: null, status: "A", added: 40, deleted: 0, changed: 40, binary: false }],
    "files",
  );

  const parsed = parseDiff(readDiff(out.diffFile));
  check.deep(parsed.warnings, [], "full.diff warnings");
  check.none(checkParse(parsed), "full.diff checkParse");
  check.eq(parsed.totals.changed, out.totalChanged, "full.diff total against the JSON");

  // The snapshot must be the merged tree, not the working tree.
  const tree = gitOut(dir, ["merge-tree", "--write-tree", out.baseSha, out.headSha]);
  const entries = gitAt(dir, ["ls-tree", "-r", "-z", tree]).stdout.split("\0").filter((line) => line.length > 0);
  check.eq(entries.length, walkFiles(out.sourceDir).length, "snapshot file count");
  for (const entry of entries) {
    const [meta, path] = entry.split("\t");
    const oid = meta.split(" ")[2];
    const full = join(out.sourceDir, path);
    check.ok(existsSync(full), `snapshot holds ${path}`);
    if (existsSync(full)) {
      check.eq(gitOut(dir, ["hash-object", full]), oid, `snapshot content of ${path}`);
    }
  }
  check.eq(existsSync(join(out.sourceDir, "untracked.txt")), false, "an untracked file is not in the snapshot");
  check.deep(readdirSync(scratch), [], "no temporary files left behind");
});

test("prep: the source snapshot holds the stored bytes", (check) => {
  const witness = join(WORK, "smudge-witness");
  const dir = conversionRepo("prep-conversion", witness);

  const before = snapshot(dir);
  const out = jsonOut(check, review(dir, ["prep"]), "prep");
  unchanged(check, before, snapshot(dir), "prep");
  if (!out) return;

  const tree = gitOut(dir, ["merge-tree", "--write-tree", out.baseSha, out.headSha]);
  const entries = treeEntries(dir, tree);
  check.eq(entries.length, walkFiles(out.sourceDir).length, "snapshot file count");
  for (const entry of entries) {
    const full = join(out.sourceDir, entry.path);
    const stored = gitAt(dir, ["cat-file", "blob", entry.oid], { encoding: "latin1" }).stdout;
    if (entry.mode === "120000") {
      check.ok(lstatSync(full).isSymbolicLink(), `${entry.path} is a symlink`);
      check.eq(readlinkSync(full), stored, `${entry.path} symlink target`);
      continue;
    }
    check.eq(readFileSync(full, "latin1"), stored, `${entry.path} holds the stored bytes`);
    const executable = (lstatSync(full).mode & 0o111) !== 0;
    check.eq(executable, entry.mode === "100755", `${entry.path} executable bit`);
  }

  // The three conversions, named one by one, so a failure says which one ran.
  check.eq(readFileSync(join(out.sourceDir, "src/win.crlf"), "latin1"), "one\nTWO\n", "eol=crlf did not convert");
  check.eq(
    readFileSync(join(out.sourceDir, "src/wide.u16"), "latin1"),
    "hello\nwide\n",
    "working-tree-encoding did not convert",
  );
  check.eq(
    readFileSync(join(out.sourceDir, "src/body.smudged"), "utf8"),
    "stored body\nand more\n",
    "the smudge filter did not replace the body",
  );
  check.eq(existsSync(witness), false, "no smudge filter command ran");
});

test("prep: a dirty working directory stops the run", (check) => {
  const dir = simpleRepo("prep-dirty");
  put(dir, "src/app.js", lines("dirty", 21));

  let before = snapshot(dir);
  let result = review(dir, ["prep"]);
  unchanged(check, before, snapshot(dir), "prep with an unstaged change");
  failedRun(check, result, 2, "prep with an unstaged change");
  check.has(result.stderr, "src/app.js", "the file is named");
  check.has(result.stderr, "Commit, stash, or discard them", "what to do next");
  check.eq(existsSync(join(dir, RUN_ROOT)), false, "no run root was created");

  gitAt(dir, ["add", "-A"]);
  before = snapshot(dir);
  result = review(dir, ["prep"]);
  unchanged(check, before, snapshot(dir), "prep with a staged change");
  failedRun(check, result, 2, "prep with a staged change");
  check.has(result.stderr, "src/app.js", "the staged file is named");
  check.eq(existsSync(join(dir, RUN_ROOT)), false, "still no run root");
});

test("prep: only the parent's own uncommitted work stops the run", (check) => {
  const dir = submoduleRepo("prep-submodule");
  const sub = join(dir, "sub");

  put(dir, "sub/lib.txt", lines("edited", 6));
  let before = snapshot(dir);
  let out = jsonOut(check, review(dir, ["prep"]), "prep with an edited submodule file");
  unchanged(check, before, snapshot(dir), "prep with an edited submodule file");
  check.eq(out?.totalChanged, 40, "the parent's own work is what gets reviewed");

  gitAt(sub, ["add", "lib.txt"]);
  before = snapshot(dir);
  jsonOut(check, review(dir, ["prep"]), "prep with a staged submodule file");
  unchanged(check, before, snapshot(dir), "prep with a staged submodule file");
  gitAt(sub, ["reset", "-q", "--hard", "HEAD"]);

  put(dir, "src/app.js", lines("touched", 20));
  before = snapshot(dir);
  let result = review(dir, ["prep"]);
  unchanged(check, before, snapshot(dir), "prep with a parent edit");
  failedRun(check, result, 2, "prep with a parent edit");
  check.has(result.stderr, "src/app.js", "the parent file is named");
  gitAt(dir, ["checkout", "-q", "--", "src/app.js"]);

  // A submodule commit the parent does not record is a parent change, and the
  // config that would hide it must not win over the pinned flag.
  gitAt(sub, ["checkout", "-q", "HEAD~1"]);
  gitAt(dir, ["config", "submodule.sub.ignore", "all"]);
  gitAt(dir, ["config", "diff.ignoreSubmodules", "all"]);
  before = snapshot(dir);
  result = review(dir, ["prep"]);
  unchanged(check, before, snapshot(dir), "prep with a moved submodule commit");
  failedRun(check, result, 2, "prep with a moved submodule commit");
  check.has(result.stderr, " M sub", "the submodule is named");

  gitAt(dir, ["add", "sub"]);
  before = snapshot(dir);
  result = review(dir, ["prep"]);
  unchanged(check, before, snapshot(dir), "prep with a staged submodule commit");
  failedRun(check, result, 2, "prep with a staged submodule commit");
  check.has(result.stderr, "M  sub", "the staged submodule is named");
});

test("prep: a detached HEAD reports no branch", (check) => {
  const dir = simpleRepo("prep-detached");
  gitAt(dir, ["checkout", "-q", "--detach"]);
  const before = snapshot(dir);
  const out = jsonOut(check, review(dir, ["prep"]), "prep");
  unchanged(check, before, snapshot(dir), "prep");
  if (!out) return;
  check.eq(out.headBranch, null, "headBranch");
  check.eq(out.headSha, gitOut(dir, ["rev-parse", "HEAD"]), "headSha");
  check.eq(out.totalChanged, 40, "totalChanged");
});

test("prep: no main and no master", (check) => {
  const dir = newRepo("prep-no-base", { branch: "dev" });
  put(dir, "src/app.js", lines("dev", 5));
  commitAll(dir, "base commit");
  gitAt(dir, ["checkout", "-q", "-b", "work"]);
  put(dir, "src/more.js", lines("more", 5));
  commitAll(dir, "work");

  const before = snapshot(dir);
  const result = review(dir, ["prep"]);
  unchanged(check, before, snapshot(dir), "prep");
  failedRun(check, result, 4, "prep");
  check.has(result.stderr, "refs/heads/main", "main is named");
  check.has(result.stderr, "refs/heads/master", "master is named");
  check.has(result.stderr, "--base", "the way out is named");
  check.eq(existsSync(join(dir, RUN_ROOT)), false, "no run root was created");
});

test("prep: an invalid --base fails and a valid one works", (check) => {
  const dir = simpleRepo("prep-base");
  const before = snapshot(dir);

  const bad = review(dir, ["prep", "--base", "refs/heads/nope"]);
  failedRun(check, bad, 4, "prep --base refs/heads/nope");
  check.has(bad.stderr, "refs/heads/nope", "the ref is named");
  check.hasNot(bad.stderr, "No base branch found", "it must not fall back to master");
  check.eq(existsSync(join(dir, RUN_ROOT)), false, "no run root was created");

  const good = jsonOut(check, review(dir, ["prep", "--base", "master"]), "prep --base master");
  unchanged(check, before, snapshot(dir), "prep");
  if (!good) return;
  check.eq(good.baseRef, "master", "baseRef");
  check.eq(good.baseSha, gitOut(dir, ["rev-parse", "refs/heads/master"]), "baseSha");
});

test("prep: a tag named main cannot win over branch master", (check) => {
  const dir = simpleRepo("prep-tag-main");
  gitAt(dir, ["tag", "main", "HEAD"]);
  const before = snapshot(dir);
  const out = jsonOut(check, review(dir, ["prep"]), "prep");
  unchanged(check, before, snapshot(dir), "prep");
  if (!out) return;
  check.eq(out.baseRef, "master", "baseRef");
  check.eq(out.baseSha, gitOut(dir, ["rev-parse", "refs/heads/master"]), "baseSha is the branch, not the tag");
  check.ok(out.totalChanged > 0, "the tag would have given an empty diff");
});

test("prep: a base behind its tracking ref warns", (check) => {
  const origin = newRepo("prep-origin");
  put(origin, "src/app.js", lines("one", 5));
  commitAll(origin, "first");
  put(origin, "src/app.js", lines("two", 5));
  commitAll(origin, "second");

  const clone = join(WORK, "prep-clone");
  gitAt(WORK, ["clone", "-q", origin, clone]);
  harden(clone);
  gitAt(clone, ["checkout", "-q", "-b", "feature"]);
  put(clone, "src/new.js", lines("new", 7));
  commitAll(clone, "feature work");
  // Local master now knows one commit less than refs/remotes/origin/master.
  gitAt(clone, ["branch", "-f", "master", "master~1"]);

  const before = snapshot(clone);
  const result = review(clone, ["prep"]);
  unchanged(check, before, snapshot(clone), "prep");
  const out = jsonOut(check, result, "prep");
  check.eq(out?.baseBehindTrackingRef, 1, "baseBehindTrackingRef");
  check.has(result.stderr, "1 commit(s) behind origin/master", "the warning");
  check.has(result.stderr, "never fetches", "it says it never fetches");
  check.ok(result.stdout.startsWith("{"), "warnings stay on stderr, so stdout is still one JSON object");
});

test("prep: no tracking ref reports null", (check) => {
  const dir = simpleRepo("prep-no-tracking");

  const before = snapshot(dir);
  const result = review(dir, ["prep"]);
  unchanged(check, before, snapshot(dir), "prep");
  const out = jsonOut(check, result, "prep");
  check.eq(out?.baseBehindTrackingRef, null, "baseBehindTrackingRef");
});

test("prep: a merge conflict stops the run safely", (check) => {
  const dir = newRepo("prep-conflict");
  put(dir, "src/app.js", "base line\n");
  commitAll(dir, "base commit");
  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  put(dir, "src/app.js", "feature line\n");
  commitAll(dir, "feature edit");
  gitAt(dir, ["checkout", "-q", "master"]);
  put(dir, "src/app.js", "master line\n");
  commitAll(dir, "master edit");
  gitAt(dir, ["checkout", "-q", "feature"]);

  const before = snapshot(dir);
  const result = review(dir, ["prep"]);
  unchanged(check, before, snapshot(dir), "prep");
  failedRun(check, result, 3, "prep");
  check.has(result.stderr, "src/app.js", "the conflicting file is named");
  check.has(result.stderr, "nothing to undo", "it says nothing needs undoing");
  check.eq(existsSync(join(dir, RUN_ROOT)), false, "no run folder was created");
});

test("prep: an empty diff is not a crash", (check) => {
  const dir = newRepo("prep-empty");
  put(dir, "src/app.js", lines("same", 4));
  commitAll(dir, "base commit");
  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  commitAll(dir, "no content change", { allowEmpty: true });

  const before = snapshot(dir);
  const result = review(dir, ["prep"]);
  unchanged(check, before, snapshot(dir), "prep");
  const out = jsonOut(check, result, "prep");
  if (!out) return;
  check.eq(out.totalChanged, 0, "totalChanged");
  check.deep(out.files, [], "files");
  check.eq(out.massive, false, "massive");
  check.has(result.stderr, "nothing to review", "the warning");
  check.eq(statSync(out.diffFile).size, 0, "full.diff is empty");
  check.ok(existsSync(join(out.sourceDir, "src/app.js")), "the snapshot is still written");
});

test("prep: zero changed lines with files is still work to review", (check) => {
  const dir = newRepo("prep-zero-lines");
  put(dir, "src/move me.txt", lines("moved", 5));
  put(dir, "src/mode.sh", "#!/bin/sh\necho hello\n");
  put(dir, "src/data.bin", Buffer.from([0, 1, 2, 3, 0, 255, 7]));
  commitAll(dir, "base commit");

  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  gitAt(dir, ["mv", "src/move me.txt", "src/moved.txt"]);
  chmodSync(join(dir, "src/mode.sh"), 0o755);
  put(dir, "src/data.bin", Buffer.from([0, 9, 9, 9, 0, 1, 2, 3]));
  commitAll(dir, "a rename, a mode change, and a binary change");

  const before = snapshot(dir);
  const result = review(dir, ["prep"]);
  unchanged(check, before, snapshot(dir), "prep");
  const out = jsonOut(check, result, "prep");
  if (!out) return;
  check.eq(out.totalChanged, 0, "totalChanged");
  check.eq(out.massive, false, "massive");
  check.deep(
    out.files.map((file) => `${file.status} ${file.path}`).sort(),
    ["M src/data.bin", "M src/mode.sh", "R src/moved.txt"],
    "files",
  );
  // The whole point of the case: no changed lines must not be reported as an
  // empty branch, because full.diff holds three records.
  check.ok(!result.stderr.includes("nothing to review"), `stderr must not dismiss the run: ${clip(result.stderr)}`);
  check.has(result.stderr, "still work to review", "the warning");
  const parsed = parseDiff(readDiff(out.diffFile));
  check.none(checkParse(parsed), "full.diff checkParse");
  check.eq(parsed.totals.changed, 0, "full.diff changed lines");
  check.eq(parsed.files.length, 3, "full.diff record count");
});

test("prep: the exclusion list and --exclude", (check) => {
  const dir = newRepo("prep-excludes");
  const files = [
    "package-lock.json",
    "node_modules/dep/index.js",
    "assets/logo.png",
    "src/bundle.min.js",
    "src/generated.js",
    "src/app.js",
  ];
  for (const path of files) put(dir, path, lines("old", 3));
  commitAll(dir, "base commit");
  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  for (const path of files) put(dir, path, lines("new", 4));
  commitAll(dir, "touch everything");

  const before = snapshot(dir);
  const first = jsonOut(check, review(dir, ["prep"]), "prep");
  check.deep(
    first?.files.map((file) => file.path),
    ["src/app.js", "src/generated.js"],
    "the default list leaves out the lock file at the top level too",
  );

  const second = jsonOut(check, review(dir, ["prep", "--exclude", "**/generated.js"]), "prep --exclude");
  unchanged(check, before, snapshot(dir), "prep");
  check.deep(second?.files.map((file) => file.path), ["src/app.js"], "--exclude adds to the list");
});

// Config that would change the shape of a diff the parser reads. `diff.srcPrefix`
// and `diff.dstPrefix` are the pair `diff.noprefix=false` does not neutralise.
const HOSTILE_DIFF_CONFIG = [
  ["diff.noprefix", "true"],
  ["diff.mnemonicPrefix", "true"],
  ["diff.srcPrefix", "i/"],
  ["diff.dstPrefix", "w/"],
  ["diff.relative", "true"],
  ["diff.external", "/bin/false"],
  ["color.ui", "always"],
  ["color.diff", "always"],
];

test("prep: hostile diff config cannot change the diff shape", (check) => {
  const dir = simpleRepo("prep-hostile-config");
  for (const [key, value] of HOSTILE_DIFF_CONFIG) gitAt(dir, ["config", key, value]);
  // The same keys once more one layer up, so neither local nor global config
  // reaches the diff.
  const globalConfig = join(WORK, "hostile.gitconfig");
  writeFileSync(
    globalConfig,
    "[diff]\n\tnoprefix = true\n\tsrcPrefix = x/\n\tdstPrefix = y/\n\texternal = /bin/false\n[color]\n\tui = always\n",
  );
  const env = { GIT_CONFIG_GLOBAL: globalConfig };

  const before = snapshot(dir);
  const out = jsonOut(check, review(dir, ["prep"], env), "prep");
  unchanged(check, before, snapshot(dir), "prep with hostile diff config");
  if (!out) return;
  check.deep(out.files.map((file) => file.path), ["src/new.js"], "prep reports the real path");

  const text = readDiff(out.diffFile);
  check.has(text, "diff --git a/src/new.js b/src/new.js", "the file start line keeps the a/ and b/ prefixes");
  check.hasNot(text, "\u001b[", "no colour escape sequences");
  const parsed = parseDiff(text);
  check.deep(parsed.warnings, [], "full.diff warnings");
  check.none(checkParse(parsed), "full.diff checkParse");
  check.eq(parsed.files[0]?.path, "src/new.js", "the parsed path");

  // The manifest is what worker packets are built from, so every path in it
  // must name a file of the merged source snapshot.
  const manifest = jsonOut(check, review(dir, ["split", "--run-dir", out.runDir], env), "split");
  if (!manifest) return;
  for (const slice of manifest.slices) {
    for (const file of slice.files) {
      check.ok(existsSync(join(manifest.sourceDir, file.path)), `${file.path} is in the source snapshot`);
    }
  }
});

// `diff.renames` decides what a rename is, and the counts and the patch must
// not answer that question differently. Under the setting `false` the patch
// alone splits a rename into a full delete plus a full add; under `copies` the
// patch alone turns a copied file into a zero-line record. Either way the
// reported total would describe trees `full.diff` does not hold, and the skill
// picks the review path from that total.
test("prep: a hostile diff.renames cannot change what the counts describe", (check) => {
  const dir = newRepo("prep-renames");
  put(dir, "src/moved.txt", lines("keep", 200));
  put(dir, "src/origin.txt", lines("origin", 200));
  commitAll(dir, "base commit");
  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  gitAt(dir, ["mv", "src/moved.txt", "src/landed.txt"]);
  put(dir, "src/landed.txt", `${lines("keep", 199)}keep 200 edited\n`);
  // A copy of one file plus an edit to its original: the record `copies` turns
  // into a zero-line copy while `--find-renames` keeps it a whole new file.
  put(dir, "src/clone.txt", lines("origin", 200));
  put(dir, "src/origin.txt", `${lines("origin", 199)}origin 200 edited\n`);
  commitAll(dir, "move, copy, and edit");

  for (const setting of ["false", "copies"]) {
    gitAt(dir, ["config", "diff.renames", setting]);
    const globalConfig = join(WORK, `renames-${setting}.gitconfig`);
    writeFileSync(globalConfig, `[diff]\n\trenames = ${setting}\n`);

    const before = snapshot(dir);
    const out = jsonOut(check, review(dir, ["prep"], { GIT_CONFIG_GLOBAL: globalConfig }), `prep diff.renames=${setting}`);
    unchanged(check, before, snapshot(dir), `prep diff.renames=${setting}`);
    if (!out) continue;

    const parsed = parseDiff(readDiff(out.diffFile));
    check.none(checkParse(parsed), `full.diff checkParse at diff.renames=${setting}`);
    check.eq(
      out.totalChanged,
      parsed.totals.changed,
      `the reported total is the total in full.diff at diff.renames=${setting}`,
    );
    check.deep(
      out.files.map((file) => `${file.path}:${file.status}`).sort(),
      parsed.files.map((file) => `${file.path}:${file.status}`).sort(),
      `the reported records are the records in full.diff at diff.renames=${setting}`,
    );
    const landed = out.files.find((file) => file.path === "src/landed.txt");
    check.eq(landed?.status, "R", `the rename survives diff.renames=${setting}`);
    check.eq(landed?.oldPath, "src/moved.txt", `the old path at diff.renames=${setting}`);
    check.eq(landed?.changed, 2, `the rename counts two changed lines at diff.renames=${setting}`);
  }
});

test("prep: a stale marked run goes, a neighbour stays", (check) => {
  const dir = simpleRepo("prep-stale");
  const first = jsonOut(check, review(dir, ["prep"]), "first prep");
  if (!first) return;
  const runRoot = dirname(first.runDir);
  const neighbour = join(runRoot, "not-a-run");
  const loose = join(runRoot, "loose.txt");
  mkdirSync(neighbour, { recursive: true });
  writeFileSync(loose, "keep me\n");

  const before = snapshot(dir);
  const result = review(dir, ["prep"]);
  unchanged(check, before, snapshot(dir), "second prep");
  const second = jsonOut(check, result, "second prep");
  check.has(result.stderr, "Removed 1 run folder(s)", "the sweep is reported");
  check.eq(existsSync(first.runDir), false, "the stale run is gone");
  check.ok(existsSync(neighbour), "an unmarked neighbour stays");
  check.ok(existsSync(loose), "a loose file stays");
  check.ok(second && existsSync(second.runDir), "the new run folder is there");
});

test("prep: a failure after the run folder exists removes it", (check) => {
  const dir = simpleRepo("prep-partial");
  // Both branches hold this blob unchanged, so the diff never reads it and
  // only the source snapshot trips over it: a failure after the run folder is
  // already on disk.
  const oid = gitOut(dir, ["rev-parse", "HEAD:README.md"]);
  rmSync(join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)), { force: true });

  const before = snapshot(dir);
  const result = review(dir, ["prep"]);
  unchanged(check, before, snapshot(dir), "prep");
  check.eq(result.code, 1, `exit code (stderr: ${clip(result.stderr)})`);
  check.eq(result.stdout, "", "stdout must stay empty");
  check.has(result.stderr, "README.md", "the failure names the object it could not read");
  const runRoot = join(dir, RUN_ROOT);
  const left = existsSync(runRoot) ? readdirSync(runRoot) : [];
  check.deep(left, [], "the partial run folder was removed");
});

test("prep: usage faults", (check) => {
  const dir = simpleRepo("prep-usage");
  const before = snapshot(dir);

  for (const args of [[], ["--help"], ["-h"], ["help"]]) {
    const result = review(dir, args);
    check.eq(result.code, 0, `${JSON.stringify(args)}: exit code`);
    check.has(result.stdout, "Usage: node review.mjs", `${JSON.stringify(args)}: usage text on stdout`);
  }

  const faults = [
    [["bogus"], 'unknown command "bogus"'],
    // A command name that `Object.prototype` answers. Each of these four
    // reached a different crash: a returned object, a returned string, a
    // returned non-function, and a throw inside the inherited call.
    [["constructor"], 'unknown command "constructor"'],
    [["toString"], 'unknown command "toString"'],
    [["__proto__"], 'unknown command "__proto__"'],
    [["hasOwnProperty"], 'unknown command "hasOwnProperty"'],
    [["prep", "--nope"], 'unknown option "--nope"'],
    // An option name that `Object.prototype` answers. Both passed the
    // unknown-option guard as an inherited function, and the second one then
    // ate "zzz" as its value and ran prep for real.
    [["prep", "--constructor"], 'unknown option "--constructor"'],
    [["prep", "--to-string", "zzz"], 'unknown option "--to-string"'],
    [["prep", "--base"], "--base needs a value"],
    [["prep", "--base="], "--base needs a value"],
    [["prep", "extra"], 'unexpected argument "extra"'],
  ];
  for (const [args, wanted] of faults) {
    const result = review(dir, args);
    failedRun(check, result, 1, JSON.stringify(args));
    check.has(result.stderr, wanted, `${JSON.stringify(args)}: message`);
    check.has(result.stderr, "--help", `${JSON.stringify(args)}: points at --help`);
  }
  check.eq(existsSync(join(dir, RUN_ROOT)), false, "a usage fault creates no run folder");
  unchanged(check, before, snapshot(dir), "usage faults");
});

// ---------------------------------------------------------------------------
// split cases
// ---------------------------------------------------------------------------

test("split: a big file is cut at hunk boundaries and re-split cleanly", (check) => {
  const dir = newRepo("split-big");
  put(dir, "src/big.txt", blockText(100, false));
  commitAll(dir, "base commit");
  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  put(dir, "src/big.txt", blockText(100, true));
  put(dir, "src/a.txt", lines("a", 333));
  put(dir, "src/b.txt", lines("b", 333));
  put(dir, "src/c.txt", lines("c", 333));
  commitAll(dir, "big change");

  const before = snapshot(dir);
  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;
  check.eq(prepped.totalChanged, 2999, "totalChanged");
  check.eq(prepped.massive, true, "massive");

  const result = review(dir, ["split", "--run-dir", prepped.runDir]);
  unchanged(check, before, snapshot(dir), "prep and split");
  const manifest = jsonOut(check, result, "split");
  if (!manifest) return;

  check.eq(manifest.target, 800, "target");
  check.eq(manifest.totalChanged, 2999, "manifest total");
  check.eq(sliceTotal(manifest), 2999, "slice totals add up");
  check.eq(manifest.oversized, false, "oversized");
  check.ok(manifest.sliceCount >= 4, `slice count: got ${manifest.sliceCount}, wanted at least 4`);
  check.eq(manifest.batches.length, Math.ceil(manifest.sliceCount / MAX_BATCH), "batch count");
  for (const slice of manifest.slices) {
    check.ok(slice.changed <= 800, `${slice.id}: ${slice.changed} changed lines is over the target`);
  }
  check.deep(
    sliceFilesOnDisk(prepped.runDir),
    manifest.slices.map((slice) => basename(slice.path)).sort(),
    "the slices folder holds exactly the planned files",
  );
  checkManifestFile(check, prepped.runDir, manifest, "split");

  const bigParts = manifest.slices.flatMap((slice) => slice.files.filter((file) => file.path === "src/big.txt"));
  check.ok(bigParts.length >= 3, `the big file was cut into ${bigParts.length} parts`);
  for (const part of bigParts) {
    check.eq(part.partial, true, "a fragment of the big file says so");
    check.eq(part.newLineRanges?.length, part.hunks, "one line range per hunk");
  }
  check.eq(
    bigParts.reduce((sum, part) => sum + part.hunks, 0),
    100,
    "every hunk of the big file is accounted for",
  );

  const diff = checkRebuild(check, prepped.runDir, manifest, "split");
  check.eq(diff.totals.changed, 2999, "full.diff total");
  checkReverseApply(check, prepped.runDir, manifest, "split");

  const again = jsonOut(check, review(dir, ["split", "--run-dir", prepped.runDir, "--target", "5000"]), "re-split");
  check.eq(again?.sliceCount, 1, "one slice at target 5000");
  check.deep(sliceFilesOnDisk(prepped.runDir), ["slice-01.diff"], "the stale slice files are gone");
  if (again) checkManifestFile(check, prepped.runDir, again, "re-split");
});

test("split: one hunk over the target is marked oversized", (check) => {
  const dir = newRepo("split-oversized");
  put(dir, "src/keep.txt", "one\n");
  commitAll(dir, "base commit");
  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  put(dir, "src/huge.txt", lines("huge", 1200));
  commitAll(dir, "one big addition");

  const before = snapshot(dir);
  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;
  check.eq(prepped.totalChanged, 1200, "totalChanged");
  check.eq(prepped.massive, true, "massive");

  const result = review(dir, ["split", "--run-dir", prepped.runDir]);
  unchanged(check, before, snapshot(dir), "prep and split");
  const manifest = jsonOut(check, result, "split");
  if (!manifest) return;
  check.eq(manifest.sliceCount, 1, "slice count");
  check.eq(manifest.oversized, true, "plan oversized");
  check.eq(manifest.slices[0].oversized, true, "slice oversized");
  check.eq(manifest.slices[0].changed, 1200, "the hunk was kept whole");
  check.eq(manifest.slices[0].files[0].hunks, 1, "hunks in the slice");
  check.eq(manifest.slices[0].files[0].partial, false, "the whole file is there");
  check.has(result.stderr, "single hunk larger than the target", "the warning");
  checkRebuild(check, prepped.runDir, manifest, "split");
});

test("split: every record type appears in exactly one slice", (check) => {
  const dir = zooRepo("split-zoo");
  const before = snapshot(dir);
  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;

  const result = review(dir, ["split", "--run-dir", prepped.runDir, "--target", "12"]);
  unchanged(check, before, snapshot(dir), "prep and split");
  const manifest = jsonOut(check, result, "split");
  if (!manifest) return;

  const diff = checkRebuild(check, prepped.runDir, manifest, "split");
  const counts = fileCounts(manifest);
  for (const file of diff.files) {
    check.eq(counts.get(file.path), 1, `${file.path}: slices holding it`);
  }
  check.eq(counts.size, diff.files.length, "every record is in the manifest");
  check.eq(sliceTotal(manifest), diff.totals.changed, "slice totals add up");

  const zeroChanged = diff.files.filter((file) => file.changed === 0).map((file) => file.path);
  check.ok(zeroChanged.length >= 3, `records with no hunks: ${clip(zeroChanged.join(", "))}`);
  for (const path of zeroChanged) check.eq(counts.get(path), 1, `${path}: a record with no hunks still gets a slice`);

  // `prep` prints a `files` array and `split` prints one inside every slice. A
  // reviewer reads the two side by side, so a field they share must mean one
  // thing: `oldPath` is the rename or copy source, never the file's own path.
  const preppedOld = new Map(prepped.files.map((file) => [file.path, file.oldPath]));
  for (const slice of manifest.slices) {
    for (const file of slice.files) {
      if (!check.ok(preppedOld.has(file.path), `${file.path}: prep must hold the same record`)) continue;
      check.eq(file.oldPath, preppedOld.get(file.path), `${file.path}: oldPath in the manifest against prep`);
    }
  }
  check.eq(preppedOld.get("src/renamed.txt"), "src/rename me.txt", "prep names the rename source");
  check.deep(
    manifest.slices.flatMap((slice) => slice.files.filter((file) => file.oldPath !== null).map((file) => file.path)),
    ["src/renamed.txt"],
    "only a rename or a copy carries an oldPath",
  );

  const written = manifest.slices.map((slice) => readDiff(join(prepped.runDir, slice.path))).join("");
  check.has(written, "+TWO\r\n", "the written slices keep carriage returns");
  check.has(written, "\\ No newline at end of file", "the written slices keep the no-newline marker");
  check.has(written, "Binary files", "the binary record was written");
  check.has(written, "rename from src/rename me.txt", "the rename record was written");
  check.has(written, "old mode 100644", "the mode-only record was written");
  checkReverseApply(check, prepped.runDir, manifest, "split");
});

// A reviewing agent reads `<sourceDir>/<path>` for context, so a path the
// manifest shortens is a file that is not there.
test("split: a path under a real a/ folder reaches the manifest whole", (check) => {
  const dir = sidePrefixRepo("split-side-prefix");
  const before = snapshot(dir);
  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;

  const manifest = jsonOut(check, review(dir, ["split", "--run-dir", prepped.runDir, "--target", "4"]), "split");
  unchanged(check, before, snapshot(dir), "prep and split");
  if (!manifest) return;

  const preppedOld = new Map(prepped.files.map((file) => [file.path, file.oldPath]));
  check.deep([...preppedOld.keys()].sort(), ["a/edited.txt", "b/copy.txt", "b/moved.txt"], "prep paths");
  check.eq(preppedOld.get("b/moved.txt"), "b/orig.txt", "prep names the rename source");
  for (const slice of manifest.slices) {
    for (const file of slice.files) {
      if (!check.ok(preppedOld.has(file.path), `${file.path}: prep must hold the same record`)) continue;
      check.eq(file.oldPath, preppedOld.get(file.path), `${file.path}: oldPath in the manifest against prep`);
    }
  }
  for (const path of fileCounts(manifest).keys()) {
    check.ok(existsSync(join(prepped.sourceDir, path)), `${path}: the snapshot holds the file the manifest names`);
  }
  checkRebuild(check, prepped.runDir, manifest, "split");
});

// `core.quotepath` decides whether git escapes a non-ASCII path as octal or
// writes its bytes raw, and the two forms are read by different branches of the
// parser, so both settings get a case. A name holding a tab is quoted either
// way.
for (const quotePath of [true, false]) {
  test(`split: non-UTF-8 bytes and non-ASCII names survive core.quotepath=${quotePath}`, (check) => {
    const dir = encodingRepo(`split-encoding-${quotePath}`, { quotePath });
    const before = snapshot(dir);
    const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
    if (!prepped) return;

    // One changed line per file, so every file is whole in exactly one slice.
    const manifest = jsonOut(check, review(dir, ["split", "--run-dir", prepped.runDir, "--target", "1"]), "split");
    unchanged(check, before, snapshot(dir), "prep and split");
    if (!manifest) return;

    const full = readFileSync(prepped.diffFile);
    check.eq(full.includes(CHINESE_OCTAL), quotePath, "core.quotepath decides how git writes the names");
    check.ok(full.includes(LATIN1_WORD), "full.diff holds the latin1 byte");

    // `--numstat -z` hands a path over raw, so a name holding a tab is where
    // the count parser can lose the tail and, with it, the status lookup that
    // is keyed by the path.
    check.deep(prepped.files.map((file) => file.path).sort(), [...ODD_NAMES].sort(), "prep file names");
    const tabbed = prepped.files.find((file) => file.path === "src/tab\there.txt");
    check.eq(tabbed?.status, "A", "the added file whose name holds a tab keeps its status");

    const written = Buffer.concat(manifest.slices.map((slice) => readFileSync(join(prepped.runDir, slice.path))));
    check.ok(written.includes(LATIN1_WORD), "the slices keep the latin1 byte");
    check.ok(!written.includes(REPLACEMENT), "no slice holds a replacement character");
    // Each file section is written once, so equal length plus the rebuild check
    // below means the cut moved every byte and invented none.
    check.eq(written.length, full.length, "slice bytes against full.diff bytes");

    check.deep([...fileCounts(manifest).keys()].sort(), [...ODD_NAMES].sort(), "manifest file names");
    checkRebuild(check, prepped.runDir, manifest, "split");
    checkReverseApply(check, prepped.runDir, manifest, "split");
  });
}

test("split: an empty diff writes no slices", (check) => {
  const dir = newRepo("split-empty");
  put(dir, "src/app.js", lines("same", 4));
  commitAll(dir, "base commit");
  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  commitAll(dir, "no content change", { allowEmpty: true });

  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;
  const before = snapshot(dir);
  const result = review(dir, ["split", "--run-dir", prepped.runDir]);
  unchanged(check, before, snapshot(dir), "split");
  const manifest = jsonOut(check, result, "split");
  if (!manifest) return;
  check.eq(manifest.sliceCount, 0, "slice count");
  check.deep(manifest.slices, [], "slices");
  check.deep(manifest.batches, [], "batches");
  check.deep(sliceFilesOnDisk(prepped.runDir), [], "the slices folder is empty");
  check.has(result.stderr, "no file sections", "the warning");
  checkManifestFile(check, prepped.runDir, manifest, "split");
});

test("split: refused run folders", (check) => {
  const dir = simpleRepo("split-refused");
  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;
  const runRoot = dirname(prepped.runDir);

  const outside = join(WORK, "split-refused-outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, MARKER), "{}\n");
  const linked = join(runRoot, "linked-run");
  symlinkSync(outside, linked);
  const unmarked = join(runRoot, "unmarked");
  mkdirSync(unmarked, { recursive: true });

  const before = snapshot(dir);
  const refused = [
    [outside, "not a run folder directly under"],
    [linked, "not a run folder directly under"],
    [unmarked, `holds no ${MARKER} file`],
    [join(runRoot, "run-does-not-exist"), "does not exist"],
    [join(prepped.runDir, "source"), "not a run folder directly under"],
    ["/tmp", "not a run folder directly under"],
  ];
  for (const [path, wanted] of refused) {
    const result = review(dir, ["split", "--run-dir", path]);
    failedRun(check, result, 1, `split --run-dir ${path}`);
    check.has(result.stderr, wanted, `split --run-dir ${path}: message`);
  }
  unchanged(check, before, snapshot(dir), "refused splits");
  check.ok(existsSync(outside), "the folder outside the run root survives");
  check.ok(existsSync(join(outside, MARKER)), "its marker survives");
  check.ok(existsSync(linked), "the symlink survives");
  check.ok(existsSync(unmarked), "the unmarked folder survives");
  check.ok(existsSync(join(prepped.runDir, "source")), "the run's source folder survives");

  // A relative path resolves to the same run folder.
  const named = jsonOut(
    check,
    review(dir, ["split", "--run-dir", join(RUN_ROOT, basename(prepped.runDir))]),
    "split with a relative --run-dir",
  );
  check.eq(named?.runDir, prepped.runDir, "the relative path names the same run");
});

test("split: an unreadable file start line stops the run", (check) => {
  const dir = simpleRepo("split-unreadable-start");
  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;
  const before = snapshot(dir);

  writeFileSync(join(prepped.runDir, "full.diff"), UNREADABLE_START_DIFF);
  const result = review(dir, ["split", "--run-dir", prepped.runDir]);
  failedRun(check, result, 6, "split on a diff whose file start line cannot be read");
  check.has(result.stderr, "could not read the paths from", "the unreadable line is named");
  check.has(result.stderr, "Nothing was reviewed", "it says nothing was reviewed");
  check.eq(sliceFilesOnDisk(prepped.runDir), null, "no slices were written");
  check.eq(existsSync(join(prepped.runDir, "manifest.json")), false, "no manifest was written");
  unchanged(check, before, snapshot(dir), "a failed self-check");
});

test("split: an unreadable hunk header stops the run", (check) => {
  const dir = simpleRepo("split-unreadable-hunk");
  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;
  const before = snapshot(dir);

  writeFileSync(join(prepped.runDir, "full.diff"), UNREADABLE_HUNK_DIFF);
  const result = review(dir, ["split", "--run-dir", prepped.runDir]);
  failedRun(check, result, 6, "split on a diff whose hunk header cannot be read");
  check.has(result.stderr, "unreadable hunk header: @@@ -1,2 -1,2 +1,2 @@@", "the unreadable header is named");
  check.has(result.stderr, "Nothing was reviewed", "it says nothing was reviewed");
  check.eq(sliceFilesOnDisk(prepped.runDir), null, "no slices were written");
  check.eq(existsSync(join(prepped.runDir, "manifest.json")), false, "no manifest was written");
  unchanged(check, before, snapshot(dir), "a failed self-check");
});

test("split: a diff with no sliceable content stops the run", (check) => {
  const dir = simpleRepo("split-unsliceable");
  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;
  const before = snapshot(dir);

  // The other two exit 6 cases feed diffs that still parse into file sections.
  // A combined diff parses into none, so the plan holds zero slices and the run
  // would read as an empty branch if the self-check ever ran after the "no file
  // sections" branch instead of before it. The changed lines are real and sit
  // outside every record, so no slice would carry them.
  writeFileSync(join(prepped.runDir, "full.diff"), COMBINED_DIFF);
  const result = review(dir, ["split", "--run-dir", prepped.runDir]);
  failedRun(check, result, 6, "split on a diff it cannot slice");
  check.has(result.stderr, 'diff content before the first "diff --git" line', "the content is named");
  check.has(result.stderr, "Nothing was reviewed", "it says nothing was reviewed");
  check.eq(sliceFilesOnDisk(prepped.runDir), null, "no slices were written");
  check.eq(existsSync(join(prepped.runDir, "manifest.json")), false, "no manifest was written");
  unchanged(check, before, snapshot(dir), "a failed self-check");
});

test("split: usage faults and a run folder with no full.diff", (check) => {
  const dir = simpleRepo("split-usage");
  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;
  const before = snapshot(dir);

  const faults = [
    [["split"], "split needs --run-dir"],
    [["split", "--run-dir", prepped.runDir, "--target", "0"], "whole number of 1 or more"],
    [["split", "--run-dir", prepped.runDir, "--target", "abc"], "whole number of 1 or more"],
    [["split", "--run-dir", prepped.runDir, "--target", "-5"], "whole number of 1 or more"],
    [["split", "--run-dir", prepped.runDir, "--target", "1.5"], "whole number of 1 or more"],
    [["split", "--run-dir", prepped.runDir, "extra"], 'unexpected argument "extra"'],
    [["split", "--run-dir", prepped.runDir, "--nope"], 'unknown option "--nope"'],
    [["split", "--run-dir"], "--run-dir needs a value"],
  ];
  for (const [args, wanted] of faults) {
    const result = review(dir, args);
    failedRun(check, result, 1, JSON.stringify(args));
    check.has(result.stderr, wanted, `${JSON.stringify(args)}: message`);
  }
  check.eq(sliceFilesOnDisk(prepped.runDir), null, "a usage fault writes no slices");

  rmSync(join(prepped.runDir, "full.diff"));
  const result = review(dir, ["split", "--run-dir", prepped.runDir]);
  failedRun(check, result, 1, "split on a run folder with no full.diff");
  check.has(result.stderr, "not a finished prep", "message");
  unchanged(check, before, snapshot(dir), "split usage faults");
});

// ---------------------------------------------------------------------------
// clean cases
// ---------------------------------------------------------------------------

test("clean: one finished run, then the same command again", (check) => {
  const dir = simpleRepo("clean-one");
  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;
  const runRoot = dirname(prepped.runDir);

  const before = snapshot(dir);
  const result = review(dir, ["clean", "--run-dir", prepped.runDir]);
  unchanged(check, before, snapshot(dir), "clean");
  const out = jsonOut(check, result, "clean");
  check.eq(result.stderr, "", "clean says nothing on stderr");
  check.deep(Object.keys(out ?? {}), ["runRoot", "removed"], "stdout keys");
  check.eq(out?.runRoot, runRoot, "runRoot");
  check.deep(out?.removed, [prepped.runDir], "removed");
  check.eq(existsSync(prepped.runDir), false, "the run folder is gone");
  check.ok(existsSync(runRoot), "the run root stays");

  const again = review(dir, ["clean", "--run-dir", prepped.runDir]);
  failedRun(check, again, 1, "clean the same run twice");
  check.has(again.stderr, "does not exist", "message");

  // The same call from inside the git folder, with a relative path.
  const second = jsonOut(check, review(dir, ["prep"]), "second prep");
  if (!second) return;
  const named = jsonOut(check, review(runRoot, ["clean", "--run-dir", basename(second.runDir)]), "clean with a relative path");
  check.deep(named?.removed, [second.runDir], "a relative path from inside the git folder works");
  check.eq(existsSync(second.runDir), false, "the run folder is gone");
});

test("clean: --all removes only marked runs", (check) => {
  const dir = simpleRepo("clean-all");
  const first = jsonOut(check, review(dir, ["prep"]), "first prep");
  if (!first) return;
  const runRoot = dirname(first.runDir);
  // A second marked run, made by hand so the first one survives the sweep prep
  // would otherwise do.
  const second = join(runRoot, "run-by-hand");
  mkdirSync(second, { recursive: true });
  writeFileSync(join(second, MARKER), "{}\n");
  const unmarked = join(runRoot, "unmarked");
  mkdirSync(unmarked, { recursive: true });
  const outside = join(WORK, "clean-all-outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, MARKER), "{}\n");
  const linked = join(runRoot, "linked-run");
  symlinkSync(outside, linked);
  const stray = join(runRoot, "stray.txt");
  writeFileSync(stray, "keep me\n");

  const before = snapshot(dir);
  const out = jsonOut(check, review(dir, ["clean", "--all"]), "clean --all");
  unchanged(check, before, snapshot(dir), "clean --all");
  check.deep([...(out?.removed ?? [])].sort(), [first.runDir, second].sort(), "removed");
  check.eq(existsSync(first.runDir), false, "the prep run is gone");
  check.eq(existsSync(second), false, "the hand-made marked run is gone");
  check.ok(existsSync(unmarked), "an unmarked folder stays");
  check.ok(existsSync(linked), "a symlink stays");
  check.ok(existsSync(outside), "what the symlink points at stays");
  check.ok(existsSync(stray), "a stray file stays");

  const twice = jsonOut(check, review(dir, ["clean", "--all"]), "second clean --all");
  check.deep(twice?.removed, [], "a second sweep removes nothing");

  const fromGitDir = jsonOut(check, review(runRoot, ["clean", "--all"]), "clean --all from inside the git folder");
  check.deep(fromGitDir?.removed, [], "the sweep works from inside the git folder");
});

test("clean: no run root at all", (check) => {
  const dir = simpleRepo("clean-no-root");
  const before = snapshot(dir);
  const out = jsonOut(check, review(dir, ["clean", "--all"]), "clean --all");
  check.deep(out?.removed, [], "removed");
  check.eq(out?.runRoot, join(realpathSync(dir), RUN_ROOT), "runRoot is still reported");

  const one = review(dir, ["clean", "--run-dir", join(dir, RUN_ROOT, "run-nothing")]);
  failedRun(check, one, 1, "clean --run-dir with no run root");
  check.has(one.stderr, "there are no runs", "message");
  unchanged(check, before, snapshot(dir), "clean with no run root");
});

test("clean: refused paths delete nothing", (check) => {
  const dir = simpleRepo("clean-refused");
  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;
  const runRoot = dirname(prepped.runDir);

  const outside = join(WORK, "clean-refused-outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, MARKER), "{}\n");
  const linked = join(runRoot, "linked-run");
  symlinkSync(outside, linked);
  const unmarked = join(runRoot, "unmarked");
  mkdirSync(unmarked, { recursive: true });
  const nested = join(runRoot, "deeper", "run-nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, MARKER), "{}\n");
  const markerIsDir = join(runRoot, "marker-is-a-folder");
  mkdirSync(join(markerIsDir, MARKER), { recursive: true });

  const before = snapshot(dir);
  const refused = [outside, linked, unmarked, nested, markerIsDir, runRoot, join(prepped.runDir, "source"), "/tmp"];
  for (const path of refused) {
    const result = review(dir, ["clean", "--run-dir", path]);
    failedRun(check, result, 1, `clean --run-dir ${path}`);
    check.ok(existsSync(path), `${path} is still there`);
  }
  unchanged(check, before, snapshot(dir), "refused cleans");
  check.ok(existsSync(prepped.runDir), "the real run survives every refusal");

  const out = jsonOut(check, review(dir, ["clean", "--run-dir", prepped.runDir]), "clean the real run");
  check.deep(out?.removed, [prepped.runDir], "the real run is still removable afterwards");
});

test("clean: usage faults", (check) => {
  const dir = simpleRepo("clean-usage");
  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;

  const before = snapshot(dir);
  const faults = [
    [["clean"], "needs --run-dir <path> or --all"],
    [["clean", "--run-dir", prepped.runDir, "--all"], "not both"],
    [["clean", "--all=yes"], "--all takes no value"],
    [["clean", "--run-dir"], "--run-dir needs a value"],
    [["clean", "--run-dir="], "--run-dir needs a value"],
    [["clean", "extra"], 'unexpected argument "extra"'],
    [["clean", "--nope"], 'unknown option "--nope"'],
    [["clean", "--target", "5"], 'unknown option "--target"'],
  ];
  for (const [args, wanted] of faults) {
    const result = review(dir, args);
    failedRun(check, result, 1, JSON.stringify(args));
    check.has(result.stderr, wanted, `${JSON.stringify(args)}: message`);
  }
  check.ok(existsSync(prepped.runDir), "no usage fault deleted anything");
  unchanged(check, before, snapshot(dir), "clean usage faults");
});

test("clean: a repository reached through a symlink", (check) => {
  const real = simpleRepo("clean-symlink-real");
  const view = join(WORK, "clean-symlink-view");
  symlinkSync(real, view);

  // Taken through the real path, because that is the repository the delete
  // must leave alone.
  const before = snapshot(real);
  const prepped = jsonOut(check, review(view, ["prep"]), "prep through the symlink");
  if (!prepped) return;
  // `git rev-parse --show-toplevel` resolves the link, so prep reports the real
  // path even when it was started through the link.
  check.eq(prepped.runDir, join(real, RUN_ROOT, basename(prepped.runDir)), "runDir is the real path");

  const throughLink = join(view, RUN_ROOT, basename(prepped.runDir));
  const out = jsonOut(check, review(view, ["clean", "--run-dir", throughLink]), "clean through the symlink");
  check.deep(out?.removed, [prepped.runDir], "the run is reported by its real path");
  check.eq(existsSync(prepped.runDir), false, "the run folder is gone");
  unchanged(check, before, snapshot(real), "prep and clean through the symlink");
});

test("clean: outside a repository", (check) => {
  const plain = join(WORK, "not-a-repo");
  mkdirSync(plain, { recursive: true });
  const inRepo = gitAt(plain, ["rev-parse", "--git-dir"], { allowFail: true });
  check.ok(inRepo.code !== 0, `the temp folder must not sit inside a repository: ${clip(inRepo.stdout)}`);

  failedRun(check, review(plain, ["clean"]), 1, "clean with no flags outside a repository");
  const sweep = review(plain, ["clean", "--all"]);
  check.eq(sweep.code, 1, `clean --all outside a repository: exit code (stderr: ${clip(sweep.stderr)})`);
  check.eq(sweep.stdout, "", "clean --all outside a repository: no JSON");
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test("end to end: prep, split, clean", (check) => {
  const dir = newRepo("end-to-end");
  put(dir, "AGENTS.md", "# rules\n");
  put(dir, "README.md", "# project\n");
  put(dir, "src/one.js", lines("one", 10));
  commitAll(dir, "base commit");
  gitAt(dir, ["checkout", "-q", "-b", "feature"]);
  put(dir, "src/one.js", lines("edited", 10));
  put(dir, "src/two.js", lines("two", 240));
  put(dir, "src/three.js", lines("three", 240));
  commitAll(dir, "feature work");

  const before = snapshot(dir);
  const prepped = jsonOut(check, review(dir, ["prep"]), "prep");
  if (!prepped) return;
  check.deep(prepped.contextFiles, ["AGENTS.md", "README.md"], "contextFiles");
  check.eq(prepped.totalChanged, 500, "totalChanged");

  const manifest = jsonOut(check, review(dir, ["split", "--run-dir", prepped.runDir, "--target", "200"]), "split");
  if (!manifest) return;
  check.eq(sliceTotal(manifest), 500, "slice totals add up");
  check.ok(manifest.sliceCount >= 3, `slice count: got ${manifest.sliceCount}, wanted at least 3`);
  check.deep(manifest.batches, chunkIds(manifest.slices.map((slice) => slice.id)), "batch suggestions");
  checkRebuild(check, prepped.runDir, manifest, "split");
  checkReverseApply(check, prepped.runDir, manifest, "split");

  const cleaned = jsonOut(check, review(dir, ["clean", "--run-dir", prepped.runDir]), "clean");
  check.deep(cleaned?.removed, [prepped.runDir], "removed");
  check.eq(existsSync(prepped.runDir), false, "the run folder is gone");
  unchanged(check, before, snapshot(dir), "the whole review");
  check.eq(gitOut(dir, ["status", "--porcelain"]), "", "the working directory is still clean");
});

function chunkIds(ids) {
  const batches = [];
  for (let at = 0; at < ids.length; at += MAX_BATCH) batches.push(ids.slice(at, at + MAX_BATCH));
  return batches;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function requireGit() {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return "git is not runnable, so nothing can be tested.";
  const found = /(\d+)\.(\d+)/.exec(result.stdout ?? "");
  if (!found) return `could not read a version from "${(result.stdout ?? "").trim()}".`;
  const [major, minor] = [Number(found[1]), Number(found[2])];
  if (major < 2 || (major === 2 && minor < 38)) {
    return `git ${major}.${minor} is too old: the CLI needs 2.38 or newer for merge-tree --write-tree.`;
  }
  return null;
}

function main() {
  const gitProblem = requireGit();
  if (gitProblem) {
    process.stderr.write(`${gitProblem}\n`);
    return 1;
  }

  WORK = realpathSync(mkdtempSync(join(tmpdir(), "code-review-selftest-")));
  const chosen = cases.filter((entry) => ONLY === null || entry.name.includes(ONLY));
  let failed = 0;
  const started = Date.now();

  try {
    for (const [at, entry] of chosen.entries()) {
      const check = new Check(entry.name);
      const from = Date.now();
      try {
        entry.body(check);
      } catch (error) {
        check.fail(`the case itself threw: ${error?.stack ?? String(error)}`);
      }
      const took = Date.now() - from;
      const number = String(at + 1).padStart(2, " ");
      if (check.problems.length === 0) {
        process.stdout.write(`ok     ${number}  ${entry.name}  (${took} ms)\n`);
        continue;
      }
      failed += 1;
      process.stdout.write(`NOT OK ${number}  ${entry.name}  (${took} ms)\n`);
      for (const problem of check.problems) process.stdout.write(`          ${problem}\n`);
    }
  } finally {
    if (KEEP) process.stdout.write(`\nkept ${WORK}\n`);
    else rmSync(WORK, { recursive: true, force: true });
  }

  const took = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`\n${chosen.length} case(s), ${failed} failed, ${took} s\n`);
  if (chosen.length === 0) {
    process.stderr.write(ONLY === null ? "no cases are registered.\n" : `no case name holds ${JSON.stringify(ONLY)}.\n`);
    return 1;
  }
  return failed === 0 ? 0 : 1;
}

process.exitCode = main();
