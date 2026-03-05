---
name: code-review
description: "Performs an agentic code review of recent changes and outputs the results. Trigger phrases: 'create a review', 'review this PR', 'review changes', 'code review'. Outputs a structured Markdown review to a file (default REVIEW.md)."
---

# Agentic Code Review

Performs a thorough code review of changes in the current git repository by examining the diff, exploring the codebase for additional context, and producing a structured Markdown review.

## Activation

This skill activates when the user asks to review code changes, e.g.:

- "create a review and output it to REVIEW.md"
- "review the changes on this branch"
- "code review"

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

Note: untracked files are acceptable — only staged or unstaged changes to tracked files block the review.

### 2. Detect the base ref and generate the diff

Determine the base branch, temporarily merge it into a detached HEAD (so the user's branch is untouched), and generate the diff. Run this as a **single** bash command so that shell variables persist:

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
git checkout --detach HEAD &&
if ! git merge --no-edit "$BASE_REF" 2>/dev/null; then
  git merge --abort 2>/dev/null
  git checkout "$ORIG_BRANCH"
  echo "ERROR: Merge conflict with $BASE_REF. Resolve conflicts before reviewing." >&2
  exit 1
fi &&
echo "BASE_REF=$BASE_REF" &&
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
  ':!**/*.woff' ':!**/*.woff2' ':!**/*.ttf' ':!**/*.eot'
```

**After capturing the diff output**, immediately restore the user's branch:

```bash
git checkout "$ORIG_BRANCH"
```

If the merge fails (conflict), restore the branch, report the conflict to the user, and **stop** — do not write a review file or continue.

The detached-HEAD merge ensures the diff reflects the changes as they will look once merged into the base branch, catching interactions with recent base branch changes, without modifying the user's branch.

If the diff is empty, write a short note to the output file saying there are no changes to review and stop.

If the diff exceeds 100,000 characters, do NOT try to review it all at once. Instead, note that the diff is large, then review the changes file-by-file: use `git diff "$BASE_REF" --name-only -- . <same exclusions as above>` to list changed files, then examine each file's diff individually with `git diff "$BASE_REF" -- <file>` and the source via `view`. Prioritize the most critical files first.

### 3. Gather context

Collect any available context to help with the review:

- Read the project's `AGENTS.md`, `CLAUDE.md`, `CRUSH.md`, or `README.md` if they exist (these should already be loaded as memory files — only read them if you haven't already).
- Check `git log --oneline "$BASE_REF"..HEAD` to understand the commit history of the changes.
- If the user provided a PR description or additional context, incorporate it.

### 4. Perform the review

Review the diff thoroughly. Check for bugs, security issues, and improvements that can be made through code simplification.

Use the `agent` tool, `grep`, `glob`, `view`, and other read-only tools to explore the codebase for additional context as needed. Specifically:

- **Investigate call sites**: When a function signature or behavior changes, use the `agent` tool or `grep` to find all callers and verify they are compatible with the change.
- **Check for stale code**: Look for code that may have become dead or redundant as a result of the changes.
- **Trace data flow**: Follow data through the changed code paths to verify correctness.
- **Verify error handling**: Ensure new code paths handle errors appropriately.

**DO NOT modify any source files during the review.** The only file you write is the review output file.

### 5. Format and write the review

Write the review to the output file. The examples below show the desired structure (the fences are illustrative — do NOT wrap the actual output file content in a code fence):

Review header:

    # Code Review

    **Base**: `<base_ref>`
    **Head**: `<current branch or HEAD>`
    **Date**: <today's date>

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

After writing the review file, give a brief summary to the user: how many issues were found at each severity level, and the output file path.
