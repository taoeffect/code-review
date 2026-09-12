---
name: code-review
description: "Performs an agentic code review of recent changes and outputs the results. Outputs a structured Markdown review to a file (default REVIEW.md)."
---

# Agentic Code Review

Review the merged result of the current branch against its base. Inspect every
changed line and write one Markdown review. The output defaults to `REVIEW.md` in
the project root unless the user names another file. Set `<skill-dir>` to the
directory containing this file.

## 1. Prepare

From the repository, run:

```bash
node <skill-dir>/scripts/review.mjs prep [--base <ref>] [--exclude <pattern>]...
```

The default base is local `main`, then local `master`. Pass a user-supplied base
to `--base`. `prep` uses local refs and does not fetch. It prints one JSON object
to stdout; warnings and errors go to stderr. Keep all reported fields.

The command creates `diffFile` and `sourceDir` from a virtual merge. It never
writes to HEAD, the real index, or working files. Inspect source under
`sourceDir`, because it matches the diff. Untracked files do not block the run.

Exit codes: 0 ready; 1 other failure; 2 staged or unstaged tracked changes; 3
merge conflict; 4 missing or invalid base; 5 Git older than 2.38; 6 failed split
self-check. On nonzero, report the stated problem and stop. For code 2, ask the
user to commit, stash, or discard the changes. Edits inside a submodule are the
one exception: they never reach this review, so they do not give code 2. A
submodule commit that differs from the one the parent records still does, because
that is a change to the parent. A base-behind warning concerns the existing local
tracking ref only.

If `files` is empty, write a no-changes note, clean as in Section 5, and stop.
Zero `totalChanged` with a nonempty `files` is still work: a rename, a mode
change, or a replaced binary changes behaviour without changing a line. Review
those records for their effects — for a rename, references to the old path,
relative paths inside the moved file, and anything keyed to a filename or
location — rather than re-reviewing unchanged code.

If `massive` is false, review the complete `diffFile` using Sections 3 and 4.
Otherwise, continue below.

## 2. Split and delegate a massive review

At 1,000 changed lines or more, run:

```bash
node <skill-dir>/scripts/review.mjs split --run-dir <runDir> [--target <lines>]
```

The default target is 800. The printed JSON is also `manifest.json`. It lists
slice paths, changed-line totals, file parts, new-line ranges, oversized status,
and suggested batches. A slice exceeds the target only when one indivisible hunk
does; it is then marked `oversized`. Slice IDs need not follow a large file's
reading order. Use manifest assignments. Suggested batches are optional; regroup
related slices if useful, with at most three agents per batch and full coverage.

- **OMP:** Use one native `task` per slice with the `reviewer` agent. Put the
  shared review contract in batch `context` and slice data in each task. Wait for
  the full batch before starting the next.
- **Crush:** Call `crush_info`. Convert `model (provider)` to `provider/model`.
  From `sourceDir`, start at most three background processes with
  `crush run -q -m <large> --small-model <small> "$PROMPT"`. Collect each with
  `job_output`. Wait for the full batch before starting the next.

Each packet identifies `sourceDir`, its slice diff, and the exact manifest file
parts and ranges. Include Sections 3 and 4 plus all user context. Require
read-only inspection and full assigned coverage. Permit wider source inspection
only for context. Do not let workers launch subagents or write the final review.
Name the worker's output channel in every packet, with this wording:

> Write your complete review to STDOUT in your final response, using Section 4's
> Markdown review format. Do not write your review to any file. The file-writing
> instructions in Sections 3 and 4 apply only to the parent (which you are not).

A worker that fails, or returns no usable review, is not retried; an explicit
no-issues review is a usable result. The parent verifies the findings it does
have against `sourceDir` and the complete `diffFile`, removes duplicates,
resolves cross-slice findings, and writes the final review. Account for every
manifest assignment as reviewed or unreviewed. If any is unreviewed, say so
plainly in an **Unreviewed files** section placed immediately after the review
header and before the first issue, listing each lost worker's assigned paths
from the manifest, and the slice or ranges for a partial-file assignment.

## 3. Gather context and review

Read each reported context file from `sourceDir` unless already available. Apply
its normal directory scope. Use the reported commit subjects, the PR description,
and every user instruction.

Review the diff thoroughly. Check for bugs, security issues, DRY violations, and improvements that can be made through code simplification.

Use read-only tool calls to explore the codebase for additional context as needed. Specifically:

- **Investigate call sites**: When a function signature or behavior changes, use available code-search tools to find all callers and verify they are compatible with the change.
- **Check for stale code**: Look for code that may have become dead or redundant as a result of the changes.
- **Trace data flow**: Follow data through the changed code paths to verify correctness.
- **Verify error handling**: Ensure new code paths handle errors appropriately.

**DO NOT modify any source files during the review.** Apart from the temporary diff, the only file you write is the review output file. That file is the parent's: a worker writes no file at all (Section 2).

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

A missing run is refused. If its path is lost, use `clean --all`; it removes only
marked tool-owned runs. Both forms print `{ "runRoot": ..., "removed": [...] }`.
Clean a known run after a later failure too. Then report the output path and issue
count at each severity.
