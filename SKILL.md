---
name: code-review
description: "Performs an agentic code review of recent changes and outputs the results. Trigger phrases: 'create a review', 'review this PR', 'review changes', 'code review'. Outputs a structured Markdown review to a file (default REVIEW.md)."
---

# Agentic Code Review

Performs a thorough code review of changes in the current git repository by examining the diff, exploring the codebase for additional context, and producing a structured Markdown review.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| Output file | `REVIEW.md` | Where to write the review. Use whatever the user specifies, or default to `REVIEW.md` in the project root. |
| Base ref | auto-detected | The base branch/ref to diff against. Auto-detects `main` or `master` and uses the merge-base for a clean diff. The user can override this explicitly. |

## Procedure

### 1. Detect the base ref and generate the diff

Determine the base branch, compute the merge-base, and generate the diff. Run this as a **single** bash command so that shell variables persist:

```bash
BASE_REF="" && \
if git rev-parse --verify origin/main >/dev/null 2>&1; then
  BASE_REF="origin/main"
elif git rev-parse --verify main >/dev/null 2>&1; then
  BASE_REF="main"
elif git rev-parse --verify origin/master >/dev/null 2>&1; then
  BASE_REF="origin/master"
elif git rev-parse --verify master >/dev/null 2>&1; then
  BASE_REF="master"
else
  echo "ERROR: Could not find main or master branch" >&2; exit 1
fi && \
MERGE_BASE=$(git merge-base HEAD "$BASE_REF") && \
echo "BASE_REF=$BASE_REF  MERGE_BASE=$MERGE_BASE" && \
git diff "$MERGE_BASE" -U15 \
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

Also check for **uncommitted changes** (staged or unstaged). If present, include them in the review by also running `git diff HEAD` (with the same exclusions) and appending that output. Mention in the review header that uncommitted changes were included.

If the diff is empty, write a short note to the output file saying there are no changes to review and stop.

If the diff exceeds 100,000 characters, do NOT try to review it all at once. Instead, note that the diff is large, then review the changes file-by-file: use `git diff "$MERGE_BASE" --name-only -- . <same exclusions as above>` to list changed files, then examine each file's diff individually with `git diff "$MERGE_BASE" -- <file>` and the source via `view`. Prioritize the most critical files first.

### 2. Gather context

Collect any available context to help with the review:

- Read the project's `AGENTS.md`, `CLAUDE.md`, `CRUSH.md`, or `README.md` if they exist (these should already be loaded as memory files — only read them if you haven't already).
- Check `git log --oneline "$MERGE_BASE"..HEAD` to understand the commit history of the changes.
- If the user provided a PR description or additional context, incorporate it.

### 3. Perform the review

With full access to the source code, review the diff thoroughly. Check for:

- **Bugs**: Logic errors, off-by-one mistakes, race conditions, incorrect assumptions.
- **Security issues**: Injection, leaked secrets, missing authentication/authorization checks, unsafe deserialization.
- **Simplification opportunities**: Overly complex code that could be clearer or shorter.

Use the `agent` tool, `grep`, `glob`, `view`, and other read-only tools to explore the codebase for additional context as needed. Specifically:

- **Investigate call sites**: When a function signature or behavior changes, use the `agent` tool or `grep` to find all callers and verify they are compatible with the change.
- **Check for stale code**: Look for code that may have become dead or redundant as a result of the changes.
- **Trace data flow**: Follow data through the changed code paths to verify correctness.
- **Verify error handling**: Ensure new code paths handle errors appropriately.

**DO NOT modify any source files during the review.** The only file you write is the review output file.

### 4. Format and write the review

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

### 5. Report completion

After writing the review file, give a brief summary to the user: how many issues were found at each severity level, and the output file path.
