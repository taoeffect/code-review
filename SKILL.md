---
name: code-review
description: "Performs an agentic code review of recent changes and outputs the results. Outputs a structured Markdown review to a file (default REVIEW.md)."
---

# Agentic Code Review

Performs a thorough code review of changes in the current git repository by examining the diff, exploring the codebase for additional context, and producing a structured Markdown review.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| Output file | `REVIEW.md` | Where to write the review. Use whatever the user specifies, or default to `REVIEW.md` in the project root. |
| Base ref | auto-detected | The base branch/ref to diff against. Auto-detects `main` or `master`. Temporarily merges the base into a detached HEAD to produce an accurate diff. The user can override this explicitly. |

## Procedure

### 1. Check for unstaged changes

Before doing anything else, run:

```bash
git status
```

If there are any staged or unstaged changes, **immediately abort the review**. Inform the user that the review cannot begin until the working directory is clean. Do NOT write a review file or continue with any subsequent steps.

Untracked files are acceptable — only staged or unstaged changes to tracked files block the review.

### 2. Detect the base ref and save the diff

Determine the base branch, temporarily merge it into a detached HEAD (so the user's branch is untouched), and save the complete diff in a dedicated temporary directory. Run this as a **single** bash command so that shell variables persist:

```bash
BASE_REF="" &&
if git rev-parse --verify main >/dev/null 2>&1; then
  BASE_REF="main"
elif git rev-parse --verify master >/dev/null 2>&1; then
  BASE_REF="master"
else
  echo "ERROR: Could not find main or master branch" >&2; exit 1
fi &&
ORIG_BRANCH=$(git branch --show-current) &&
DIFF_DIR=$(mktemp -d) &&
DIFF_FILE="$DIFF_DIR/full.diff" &&
git checkout --detach HEAD &&
if ! git merge --no-edit "$BASE_REF" 2>/dev/null; then
  git merge --abort 2>/dev/null
  git checkout "$ORIG_BRANCH"
  rm -rf "$DIFF_DIR"
  echo "ERROR: Merge conflict with $BASE_REF. Resolve conflicts before reviewing." >&2
  exit 1
fi &&
git diff "$BASE_REF" -U15 \
  -- . \
  ':!**/package-lock.json' \
  ':!**/pnpm-lock.yaml' \
  ':!**/yarn.lock' \
  ':!**/go.sum' \
  ':!**/*.min.js' ':!**/*.min.css' \
  ':!**/node_modules/**' \
  ':!**/vendor/**' \
  ':!**/dist/**' \
  ':!**/build/**' \
  ':!**/*.svg' ':!**/*.png' ':!**/*.jpg' ':!**/*.jpeg' \
  ':!**/*.gif' ':!**/*.ico' ':!**/*.webp' \
  ':!**/*.woff' ':!**/*.woff2' ':!**/*.ttf' ':!**/*.eot' \
  > "$DIFF_FILE" &&
git checkout "$ORIG_BRANCH" &&
printf 'BASE_REF=%s\nDIFF_DIR=%s\nDIFF_FILE=%s\nDIFF_BYTES=%s\n' \
  "$BASE_REF" "$DIFF_DIR" "$DIFF_FILE" "$(wc -c < "$DIFF_FILE")"
```

Record the printed paths. Use `DIFF_FILE` as the complete diff source for the review and keep `DIFF_DIR` until the review is finished.

If the merge fails (conflict), restore the branch, report the conflict to the user, and **stop** — do not write a review file or continue.

The detached-HEAD merge ensures the diff reflects the changes as they will look once merged into the base branch, catching interactions with recent base branch changes, without modifying the user's branch.

If `DIFF_FILE` is empty, write a short note to the output file saying there are no changes to review, remove `DIFF_DIR`, and stop.

Determine the number of changed lines in `DIFF_FILE`, both in total and per file. A changed line is an added or deleted source line; do not count diff headers, hunk headers, or unchanged context lines. A **massive PR** is one with at least 1,000 changed lines. Review smaller PRs directly by continuing to Section 3. For a massive PR, follow the process below.

#### Massive PR process

Use subagents to review every changed line without placing the complete diff in one agent's context.

1. **Partition the diff intelligently.** Create self-contained slice files inside `DIFF_DIR`. Each slice should contain no more than approximately 800 changed lines and must retain the file headers and hunk headers needed to understand its patch. Prefer groups of related files or coherent changes. Keep a file together when it fits. Split an oversized file at coherent hunk boundaries when needed; never split in the middle of a hunk. Record the files, or file portions, included in every slice.
2. **Balance cohesion and size.** Use only as many subagents as the changed-line count requires. For example, when one large file accounts for most of fewer than 1,600 changed lines, assign that file primarily to one subagent and the smaller files to a second. If the smaller files exceed the second slice's capacity, move coherent hunks or files to the first slice while keeping both near the 800-line target. Do not create three slices when two balanced, coherent slices are sufficient.
3. **Review in batches.** Assign one slice to each subagent, with at most three subagents per batch. Use the launch method named in the system prompt:
   - **OMP:** Launch each packet with the native `task` tool and the `reviewer` agent.
   - **Crush:** First call `crush_info`. From its `[model]` section, convert each `model (provider)` value to `provider/model`. Then launch each packet from the project root with the Bash tool, `run_in_background: true`, and `crush run -q -m <large> --small-model <small> "$PROMPT"`. For example, `glm-5.3 (zai)` becomes `zai/glm-5.3`. Collect every result with `job_output`.

   Wait for all subagents in the current batch before starting the next. Continue in batches of up to three until every slice is reviewed.
4. **Give each subagent a complete review packet.** Its instructions must contain:
   - the applicable instructions from Section 3, including all additional context and instructions supplied by the user;
   - the path to its slice diff file and an explicit statement that this is the diff it must review;
   - the exact list of files and file portions for which it is responsible;
   - the review instructions from Section 4;
   - the issue format, severity definitions, and rules from Section 5; and
   - an instruction to report its findings to the parent agent rather than write the final review file.

   The packet should otherwise preserve the substance of this skill, except for instructions about creating or launching subagents. Subagents may inspect the wider codebase with read-only tools for context, but they must review every assigned change and avoid reviewing unassigned changes unless needed to explain a cross-file issue.
5. **Integrate the reports.** After all batches finish, verify the reported issues against the source and complete diff, remove duplicates, reconcile cross-slice findings, order all valid issues by severity, and write one final review using Section 5. The parent agent remains responsible for full coverage and the final review.

### 3. Gather context

Collect any available context to help with the review:

- Read the project's `AGENTS.md`, `CLAUDE.md`, `CRUSH.md`, or `README.md` if they exist (these should already be loaded as memory files — only read them if you haven't already).
- Check `git log --oneline "$BASE_REF"..HEAD` to understand the commit history of the changes.
- If the user provided a PR description or additional context, incorporate it.

### 4. Perform the review

Review the diff thoroughly. Check for bugs, security issues, DRY violations, and improvements that can be made through code simplification.

Use read-only tool calls to explore the codebase for additional context as needed. Specifically:

- **Investigate call sites**: When a function signature or behavior changes, use available code-search tools to find all callers and verify they are compatible with the change.
- **Check for stale code**: Look for code that may have become dead or redundant as a result of the changes.
- **Trace data flow**: Follow data through the changed code paths to verify correctness.
- **Verify error handling**: Ensure new code paths handle errors appropriately.

**DO NOT modify any source files during the review.** Apart from the temporary diff, the only file you write is the review output file.

### 5. Format and write the review

Write the review to the output file. The examples below show the desired structure (the fences are illustrative — do NOT wrap the actual output file content in a code fence):

Review header:

    # Code Review

    **Base**: `<base_ref>`
    **Head**: `<current branch or HEAD>`
    **Date**: <today's date>
    **Model**: <if known, model name used for review here>

    ---

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
| ⚪️ | Lower confidence OR lower importance |

**Rules:**

- Prioritize finding 🔴 and 🟡 issues. List issues in order from most to least important.
- Number all issues sequentially starting from 1.
- Be specific: quote concrete lines, reference `file:line` locations.
- Provide actual code suggestions in fenced code blocks.
- Do NOT comment on code that has no issues (no "looks good!" fluff).
- If no problems are found, state that clearly and stop.

### 6. Report completion

After writing the review file, remove `DIFF_DIR`, then give a brief summary to the user: how many issues were found at each severity level, and the output file path.
