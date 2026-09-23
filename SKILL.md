---
name: code-review
description: "Performs an agentic code review of recent changes and outputs the results. Outputs a structured Markdown review (default REVIEW.md)."
---

# Agentic Code Review

Review the merged result of the current branch against its base. Inspect every
changed line and write one Markdown review. The output defaults to `REVIEW.md` in
the project root unless the user names another file or no file (e.g. "STDOUT",
"print to screen", "no file", etc). `<skill-dir>` refers to the directory containing
this SKILL.md file.

## 1. Prepare

From the git repository, run:

```bash
node <skill-dir>/scripts/review.mjs prep [--base <ref>] [--exclude <pattern>]...
```

The default base is local `main`, then local `master`. Pass a user-supplied base
to `--base`. `prep` uses local refs and does not fetch. It prints one JSON object
to stdout; warnings and errors go to stderr. Do not drop fields from that JSON;
later steps depend on them.

The command creates `diffFile` and `sourceDir` from a virtual merge. It never
writes to HEAD, the real index, or working files. Inspect source under
`sourceDir`, because it matches the diff. Untracked files do not block the run.

Exit codes:

- `prep`: 0 ready; 1 other failure; 2 staged or unstaged tracked changes; 3
  merge conflict; 4 missing or invalid base; 5 Git older than 2.38.
- `split`: 0 success; 1 other failure; 6 failed self-check.
- `clean`: 0 success; 1 failure.

Check every command's exit code. On any nonzero exit code, report the error message
and stop. If `prep` succeeded but a subsequent `split` or review step fails, clean
the active `runDir` as described in Section 5, reporting any cleanup failure.

For `prep` exit code 2 (dirty working tree), ask the user to commit, stash, or
discard their changes. Note that uncommitted edits inside a submodule checkout do
not trigger code 2 because they are not part of this review; however, a changed
submodule commit pointer (gitlink) in the parent repository does trigger code 2.
Any base-behind warning emitted by `prep` is informational only and refers to the
local tracking ref.

Handle the `prep` output as follows:

- **Empty `files`:** If `files` is empty, write a note stating no changes were found,
  clean the run via Section 5, and stop.
- **Zero `totalChanged` with nonempty `files`:** A pure rename, file mode change, or
  binary replacement changes behavior without adding or deleting lines. Review
  these records for side effects—for renames, check old-path references, relative
  paths within moved files, and filename- or location-sensitive behavior—rather
  than re-reviewing unchanged contents.
- **Single-agent review (`massive` is false):** Review the entire `diffFile` following
  Sections 3 and 4, clean up and report via Section 5, and stop.
- **Massive review (`massive` is true):** Proceed to Section 2 below to split and
  delegate.

## 2. Split and delegate a massive review

At 1,000 changed lines or more, run:

```bash
node <skill-dir>/scripts/review.mjs split --run-dir <runDir> [--target <lines>]
```

The target line count defaults to 800. `split` writes and prints `manifest.json`,
which details slice file paths, changed-line counts, file parts, new-line ranges
(`newLineRanges`), oversized flags, and suggested batches (`batches`).

Key slicing and batching rules:
- **Oversized slices:** A slice exceeds `--target` only when an individual diff hunk
  exceeds it on its own; such slices are flagged as `oversized: true`.
- **Slice ordering:** Slice IDs do not guarantee sequential reading order for a
  large file split across multiple slices. Rely on each file part's assigned
  `newLineRanges` rather than assuming order from slice numbers.
- **Batching:** `batches` groups slices into suggested rounds of up to three slices.
  You may regroup slices to keep related files together, provided every slice is
  assigned and each batch runs at most three worker agents concurrently.

Path handling for worker prompts:
In the manifest, `runDir`, `diffFile`, `sourceDir`, `sliceDir`, and `manifestFile`
are absolute, but all slice and file paths are relative. You must convert all paths
to absolute before dispatching prompts to workers:
- A slice's `path` (e.g. `slices/slice-01.diff`) is relative to `runDir` and must be
  joined to `runDir`.
- A file part's `path` and `oldPath` are repository paths and must be joined to
  `sourceDir`.
Never pass bare relative paths in worker prompts.

- **OMP:** Use one native `task` per slice with the `reviewer` agent. Put the
  shared review contract in batch `context` and slice data in each task. Wait for
  the full batch before starting the next.
- **Crush:** Call `crush_info` to get the configured `large` and `small` models.
  Convert the `model (provider)` format into `provider/model` (for example,
  `claude-3-5-sonnet (anthropic)` becomes `anthropic/claude-3-5-sonnet`).
  With working directory set to `sourceDir`, launch at most three background
  processes using `crush run -q -m <large> --small-model <small> "$PROMPT"` where
  `$PROMPT` contains the full prompt text. Collect results with `job_output`.
  Wait for all workers in the current batch to finish before starting the next batch.

Each worker prompt identifies `sourceDir`, its slice diff by absolute path, and the
exact manifest file parts and ranges. Include Sections 3 and 4 plus all user
context. Require read-only inspection and full assigned coverage. Permit wider
source inspection only for context. Do not let workers launch subagents or write
the final review. Name the worker's output channel in every prompt, with this
wording:

> Write your complete review to STDOUT in your final response, using Section 4's
> Markdown review format. Do not write your review to any file. The file-writing
> instructions in Sections 3 and 4 apply only to the parent (which you are not).

A worker that fails, or returns no usable review, is not retried; an explicit
no-issues review is a usable result. The parent verifies the findings it does
have against `sourceDir` and the complete `diffFile`, removes duplicates,
resolves cross-slice findings, and writes the final review.

Account for every manifest assignment as either reviewed or unreviewed. If any
worker fails or produces no usable review, document the unreviewed code in an
`## Unreviewed files` section located immediately below the review header (before
any issues). For each unreviewed item, list:
- The file path(s)
- The slice identifier
- The hunk/new-line ranges if it was a partial-file assignment

## 3. Gather context and review

Read any files listed in `contextFiles` from `sourceDir` (such as `AGENTS.md` or
`README.md`) if not already loaded, observing any repository or directory guidelines
they define. Incorporate the reported `commits` subjects, any provided PR/MR
description, and all user instructions to understand the intent of the changes.

Review the diff thoroughly for:

- **Highest priority**: any bugs, security issues, DRY violations, and improvements that can be made through code simplification
- spelling or grammar mistakes in user-facing strings or log messages
- poorly named identifiers like variables, selectors, functions/methods, types or classes

As you review the diff, use read-only tool calls to explore the codebase for additional context as needed. Specifically:

- **Investigate call sites**: When a function signature or behavior changes, use available code-search tools to find all callers and verify they are compatible with the change.
- **Check for stale code**: Look for code that may have become dead or redundant as a result of the changes.
- **Trace data flow**: Follow data through the changed code paths to verify correctness.
- **Verify error handling**: Ensure new code paths handle errors appropriately.

**DO NOT modify any source files during the review.** The only file you write is the final review output file (unless outputting to STDOUT). A worker subagent must never write any files at all (see Section 2).

## 4. Format and write the review

The parent writes the review to the output file; a worker writes the same format to STDOUT instead (Section 2). The examples below show the desired structure (the fences are illustrative — do NOT wrap the actual output file content in a code fence):

Review header:

    # Code Review

    **Base**: `<base_ref>`
    **Head**: `<current branch or HEAD>`
    **Date**: <today's date>
    **Model**: <if known, model name used for review here>

    ---

    <an Unreviewed files section, when a split review lost a worker (Section 2)>

    <issues in priority order, or a statement that no issues were found>

Each issue:

    ## <N>. <severity emoji> <Short issue title>

    - [ ] Addressed
    - [ ] Dismissed

    <Detailed description of the issue. Be specific — quote the concrete lines
    that are problematic using `file.ts:41` or `file.ts:50-70` notation.
    Provide code improvement suggestions with actual code in fenced blocks.>

**Severity ratings:**

| Emoji | Meaning |
|-------|---------|
| 🔴 | High importance AND high confidence |
| 🟡 | Medium importance AND high confidence |
| ⚪ | Lower confidence OR lower importance |

**Rules:**

- Prioritize finding 🔴 and 🟡 issues. List issues in order from most to least important.
- Number all issues sequentially starting from 1.
- Be specific: quote concrete lines, reference `file:line` locations.
- Provide actual code suggestions in fenced code blocks.
- Do NOT comment on code that has no issues (no "looks good!" fluff).
- If no problems are found, state that clearly and stop.

## 5. Clean up and report

After writing the review, run once:

```bash
node <skill-dir>/scripts/review.mjs clean --run-dir <runDir>
```

`clean` removes only marked tool-owned runs under the run root. If the specific
`runDir` path was lost due to an error, run `node <skill-dir>/scripts/review.mjs clean --all`.
Both commands output `{ "runRoot": ..., "removed": [...] }`.

Finally, print a summary to the user indicating the path to the written review
file and the total count of issues identified at each severity level (🔴, 🟡, ⚪).
