// The unified diff parser and slicer for the code-review CLI.
//
// The parser is lossless on purpose. Joining the parsed records back together
// gives back the exact bytes it read, so `split` can prove that no hunk was
// dropped instead of hoping. Every record keeps its own slice of the source
// text, which V8 shares with the parent string rather than copying.
//
// The source text is a byte string: one character per byte of the diff, as
// `readFileSync(path, "latin1")` produces. A diff can hold bytes that are not
// valid UTF-8, because git writes a textual diff for any source file it does
// not call binary, whatever encoding that file uses. Decoding such a diff would
// replace those bytes with U+FFFD and the slices would stop matching the source
// under review. So patch text stays raw here, and only the paths this module
// reports are decoded as UTF-8, exactly once, in `unquotePath`.
//
// This file is pure. It never reads a file and it never calls git.

/** Changed lines we aim for in one slice. */
export const DEFAULT_TARGET = 800;

/** Most slices one batch of review subagents may hold. */
export const MAX_BATCH = 3;

/** Folder name, under the run folder, that holds the slice files. */
export const SLICE_DIR = "slices";

const FILE_START = "diff --git ";
const HUNK_START = "@@";
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Read a `git diff` byte string, as the file header describes.
 *
 * Returns `{ source, preamble, files, totals, warnings }`. `preamble` holds any
 * text before the first `diff --git` line and is normally empty. A text with no
 * `diff --git` line at all parses as zero files and one warning, because the
 * only producer of our input is `git diff`.
 *
 * Each file record is
 * `{ index, path, oldPath, newPath, status, binary, modeOnly, renameOnly,
 *    header, text, hunks, added, deleted, changed }`, where `path`, `oldPath`,
 *    and `newPath` are decoded text and `header` and `text` are raw bytes.
 *
 * Each hunk record is
 * `{ index, headerLine, text, heading, oldStart, oldLines, newStart, newLines,
 *    added, deleted, context, changed, countedOld, countedNew }`.
 */
export function parseDiff(source) {
  const cursor = new Cursor(source);
  const warnings = [];
  const files = [];

  const preambleStart = cursor.pos;
  while (cursor.peek() !== null && !cursor.peek().startsWith(FILE_START)) cursor.take();
  const preamble = source.slice(preambleStart, cursor.pos);
  if (preamble.length > 0) {
    warnings.push(`${countLines(preamble)} line(s) before the first "diff --git" line were kept as a preamble`);
  }

  while (cursor.peek() !== null) files.push(parseFile(cursor, files.length, warnings));

  const totals = { added: 0, deleted: 0, changed: 0 };
  for (const file of files) {
    totals.added += file.added;
    totals.deleted += file.deleted;
    totals.changed += file.changed;
  }
  return { source, preamble, files, totals, warnings };
}

function parseFile(cursor, index, warnings) {
  const start = cursor.pos;
  const headerLines = [cursor.take()];
  while (cursor.peek() !== null && !isHunkStart(cursor.peek()) && !cursor.peek().startsWith(FILE_START)) {
    headerLines.push(cursor.take());
  }
  const headerEnd = cursor.pos;

  const hunks = [];
  while (isHunkStart(cursor.peek())) hunks.push(parseHunk(cursor, hunks.length, warnings));

  const facts = readHeaderFacts(headerLines, warnings);
  let added = 0;
  let deleted = 0;
  for (const hunk of hunks) {
    added += hunk.added;
    deleted += hunk.deleted;
  }
  return {
    index,
    path: facts.newPath ?? facts.oldPath ?? "",
    oldPath: facts.oldPath,
    newPath: facts.newPath,
    status: facts.status,
    binary: facts.binary,
    modeOnly: hunks.length === 0 && !facts.binary && facts.modeChanged && facts.status === "M",
    renameOnly: hunks.length === 0 && (facts.status === "R" || facts.status === "C"),
    header: cursor.source.slice(start, headerEnd),
    text: cursor.source.slice(start, cursor.pos),
    hunks,
    added,
    deleted,
    changed: added + deleted,
  };
}

// The line counts in the hunk header say where the body ends. Trusting them,
// rather than the first character of the next line, is what keeps a body line
// such as "diff --git ..." inside a patch-of-a-patch from starting a new file
// section. `\ No newline at end of file` can appear anywhere in the body and
// counts for neither side.
function parseHunk(cursor, index, warnings) {
  const start = cursor.pos;
  const headerLine = cursor.take();
  const found = HUNK_HEADER.exec(headerLine);
  if (!found) {
    warnings.push(`unreadable hunk header: ${headerLine}`);
  }
  const oldLines = found ? optionalCount(found[2]) : 0;
  const newLines = found ? optionalCount(found[4]) : 0;

  let remainingOld = oldLines;
  let remainingNew = newLines;
  let added = 0;
  let deleted = 0;
  let context = 0;
  let blankAsContext = 0;

  while (cursor.peek() !== null && (remainingOld > 0 || remainingNew > 0)) {
    const line = cursor.peek();
    const kind = line.length === 0 ? " " : line[0];
    if (kind === "\\") {
      cursor.take();
      continue;
    }
    if (kind === " ") {
      if (line.length === 0) blankAsContext += 1;
      cursor.take();
      remainingOld -= 1;
      remainingNew -= 1;
      context += 1;
      continue;
    }
    if (kind === "+") {
      cursor.take();
      remainingNew -= 1;
      added += 1;
      continue;
    }
    if (kind === "-") {
      cursor.take();
      remainingOld -= 1;
      deleted += 1;
      continue;
    }
    break;
  }
  while (cursor.peek() !== null && cursor.peek().startsWith("\\")) cursor.take();

  if (blankAsContext > 0) {
    warnings.push(`${headerLine}: ${blankAsContext} empty body line(s) read as context lines`);
  }
  return {
    index,
    headerLine,
    text: cursor.source.slice(start, cursor.pos),
    heading: found ? found[5] : "",
    oldStart: found ? Number(found[1]) : 0,
    oldLines,
    newStart: found ? Number(found[3]) : 0,
    newLines,
    added,
    deleted,
    context,
    changed: added + deleted,
    countedOld: oldLines - remainingOld,
    countedNew: newLines - remainingNew,
  };
}

// Paths come from the `---` and `+++` lines when they exist, because those are
// unambiguous. A binary, mode-only, or pure rename section has no such lines, so
// the rename lines or the `diff --git` line answer instead.
function readHeaderFacts(headerLines, warnings) {
  let status = "M";
  let binary = false;
  let modeChanged = false;
  let oldSide = null;
  let newSide = null;
  let renameFrom = null;
  let renameTo = null;

  for (const line of headerLines) {
    if (line.startsWith("--- ")) oldSide = line.slice(4);
    else if (line.startsWith("+++ ")) newSide = line.slice(4);
    else if (line.startsWith("new file mode ")) status = "A";
    else if (line.startsWith("deleted file mode ")) status = "D";
    else if (line.startsWith("rename from ")) {
      status = "R";
      renameFrom = unquotePath(line.slice(12));
    } else if (line.startsWith("rename to ")) {
      status = "R";
      renameTo = unquotePath(line.slice(10));
    } else if (line.startsWith("copy from ")) {
      status = "C";
      renameFrom = unquotePath(line.slice(10));
    } else if (line.startsWith("copy to ")) {
      status = "C";
      renameTo = unquotePath(line.slice(8));
    } else if (line.startsWith("old mode ") || line.startsWith("new mode ")) modeChanged = true;
    else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) binary = true;
  }

  const fromLine = parseFileStartLine(headerLines[0], warnings);
  let oldPath = fromLine.oldPath;
  let newPath = fromLine.newPath;
  if (oldSide !== null) oldPath = sidePath(oldSide);
  if (newSide !== null) newPath = sidePath(newSide);
  if (renameFrom !== null) oldPath = stripSidePrefix(renameFrom);
  if (renameTo !== null) newPath = stripSidePrefix(renameTo);
  return { status, binary, modeChanged, oldPath, newPath };
}

function sidePath(raw) {
  const path = unquotePath(raw);
  return path === "/dev/null" ? null : stripSidePrefix(path);
}

// `diff --git a/x b/x` is ambiguous when a path holds a space, because there is
// no separator. Git quotes a path that holds anything worse than a space, so the
// unquoted case is settled by looking for the split where both sides name the
// same path.
function parseFileStartLine(line, warnings) {
  const rest = line.slice(FILE_START.length);
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest);
    return { oldPath: sidePath(rest.slice(0, end + 1)), newPath: sidePath(rest.slice(end + 2)) };
  }
  const quotedSecond = rest.indexOf(' "');
  if (quotedSecond !== -1) {
    return { oldPath: sidePath(rest.slice(0, quotedSecond)), newPath: sidePath(rest.slice(quotedSecond + 1)) };
  }
  for (let at = rest.indexOf(" b/"); at !== -1; at = rest.indexOf(" b/", at + 1)) {
    const left = rest.slice(0, at);
    const right = rest.slice(at + 1);
    if (left.startsWith("a/") && left.slice(2) === right.slice(2)) {
      return { oldPath: sidePath(left), newPath: sidePath(right) };
    }
  }
  const last = rest.lastIndexOf(" b/");
  if (last !== -1) {
    return { oldPath: sidePath(rest.slice(0, last)), newPath: sidePath(rest.slice(last + 1)) };
  }
  warnings.push(`could not read the paths from: ${line}`);
  return { oldPath: null, newPath: null };
}

function stripSidePrefix(path) {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

const C_ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34 };
const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();
const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * Undo the quoting git puts on a path, and give back text. Git quotes a path
 * that holds a control character, a double quote, a backslash, or a byte above
 * ASCII, and writes the bytes as octal escapes. An unquoted path that holds a
 * space gets a trailing tab on the `---` and `+++` lines instead.
 *
 * `raw` is a byte string, as the file header describes, so an unquoted path
 * carries its UTF-8 bytes one per character. Both forms therefore end the same
 * way: recover the bytes, then decode them as UTF-8 exactly once. With
 * `core.quotepath=false` git leaves those bytes raw even inside a quoted path,
 * which is why the quoted branch reads them as bytes too.
 */
export function unquotePath(raw) {
  if (!raw.startsWith('"')) return decodeBytes(raw.endsWith("\t") ? raw.slice(0, -1) : raw);
  const inner = raw.slice(1, quotedEnd(raw));
  const bytes = [];
  for (let at = 0; at < inner.length; at += 1) {
    const char = inner[at];
    if (char !== "\\") {
      pushByte(bytes, char);
      continue;
    }
    const escape = inner[at + 1];
    if (escape === undefined) break;
    at += 1;
    if (escape >= "0" && escape <= "7") {
      let octal = escape;
      while (octal.length < 3 && inner[at + 1] >= "0" && inner[at + 1] <= "7") {
        octal += inner[at + 1];
        at += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    const known = C_ESCAPES[escape];
    if (known === undefined) pushByte(bytes, escape);
    else bytes.push(known);
  }
  return utf8Decoder.decode(new Uint8Array(bytes));
}

// An ASCII path is already text, and every path in a diff normally is one, so
// the byte walk below is skipped for it.
function decodeBytes(text) {
  if (ASCII_ONLY.test(text)) return text;
  const bytes = [];
  for (const char of text) pushByte(bytes, char);
  return utf8Decoder.decode(new Uint8Array(bytes));
}

// A character above 0xff cannot come from a byte string. It can only come from a
// caller that decoded its input itself, so keep its own UTF-8 bytes.
function pushByte(bytes, char) {
  const code = char.codePointAt(0);
  if (code <= 0xff) bytes.push(code);
  else for (const byte of utf8Encoder.encode(char)) bytes.push(byte);
}

function quotedEnd(text) {
  for (let at = 1; at < text.length; at += 1) {
    if (text[at] === "\\") at += 1;
    else if (text[at] === '"') return at;
  }
  return text.length - 1;
}

/**
 * One file's diff, holding only the hunks given. The full file header is
 * repeated, so every fragment reads as a patch on its own. With every hunk of
 * the file given, the result is the file's own bytes.
 */
export function fileFragment(file, hunks = file.hunks) {
  let text = file.header;
  for (const hunk of hunks) text += hunk.text;
  return text;
}

/** The diff text of one slice. */
export function sliceText(slice) {
  let text = "";
  for (const part of slice.parts) text += fileFragment(part.file, part.hunks);
  return text;
}

/**
 * Group the parsed files into slices of about `target` changed lines.
 *
 * The biggest work goes first, then the small files even the slices out. A file
 * that fits stays whole. A file that does not fit is cut at hunk boundaries
 * only. A single hunk over the target keeps its own slice, which is marked
 * oversized. Every other slice stays within the target, so the slice count can
 * be more than `ceil(total / target)` when the work does not pack neatly.
 *
 * Returns `{ target, total, sliceCount, oversized, slices, batches }`, where a
 * slice is `{ id, index, path, changed, oversized, parts }` and a part is
 * `{ file, hunks, changed, partial }`. `parts` and `hunks` hold the parsed
 * records, so `sliceText` can write the slice. Use `describePlan` for the
 * JSON-safe form.
 */
export function planSlices({ files, target = DEFAULT_TARGET }) {
  if (!(target > 0)) throw new RangeError(`target must be a positive number, got ${target}`);
  const total = files.reduce((sum, file) => sum + file.changed, 0);
  const units = unitsFor(files, target);

  units.sort(byWorkThenPlace);
  const bins = [];
  for (const unit of units) {
    if (unit.oversized) {
      bins.push({ units: [unit], changed: unit.changed });
      continue;
    }
    // The emptiest slice that still has room for the whole unit.
    let roomy = null;
    for (const bin of bins) {
      if (bin.changed + unit.changed > target) continue;
      if (roomy === null || bin.changed < roomy.changed) roomy = bin;
    }
    if (roomy) {
      roomy.units.push(unit);
      roomy.changed += unit.changed;
    } else {
      // Nothing has room, so open a slice rather than push one over the target.
      // `unitsFor` already cut every unit down to the target, so a fresh slice
      // always fits it. That is what makes "every slice is within the target,
      // unless one hunk alone beats it" true, and `checkPlan` proves it.
      bins.push({ units: [unit], changed: unit.changed });
    }
  }

  const slices = bins.map((bin) => ({ parts: partsFrom(bin.units), changed: bin.changed }));
  slices.sort(byDiffOrder);
  const width = Math.max(2, String(slices.length).length);
  for (const [index, slice] of slices.entries()) {
    slice.index = index;
    slice.id = `slice-${String(index + 1).padStart(width, "0")}`;
    slice.path = `${SLICE_DIR}/${slice.id}.diff`;
    slice.oversized = slice.parts.some((part) => part.hunks.some((hunk) => hunk.changed > target));
  }
  return {
    target,
    total,
    sliceCount: slices.length,
    oversized: slices.some((slice) => slice.oversized),
    slices,
    batches: batchesOf(slices, MAX_BATCH),
  };
}

// A unit is the smallest thing an allocator may move: a whole file, or one run
// of hunks from a file too big to keep whole.
function unitsFor(files, target) {
  const units = [];
  for (const file of files) {
    if (file.hunks.length === 0 || file.changed <= target) {
      units.push({ file, hunks: file.hunks, changed: file.changed, oversized: false });
      continue;
    }
    let group = [];
    let groupChanged = 0;
    const flush = () => {
      if (group.length === 0) return;
      units.push({ file, hunks: group, changed: groupChanged, oversized: false });
      group = [];
      groupChanged = 0;
    };
    for (const hunk of file.hunks) {
      if (hunk.changed > target) {
        flush();
        units.push({ file, hunks: [hunk], changed: hunk.changed, oversized: true });
        continue;
      }
      if (groupChanged + hunk.changed > target) flush();
      group.push(hunk);
      groupChanged += hunk.changed;
    }
    flush();
  }
  return units;
}

// Biggest first. Files from the same folder sort next to each other, so equal
// sized work from one folder tends to land in one slice.
function byWorkThenPlace(left, right) {
  if (left.changed !== right.changed) return right.changed - left.changed;
  const leftDir = folderOf(left.file.path);
  const rightDir = folderOf(right.file.path);
  if (leftDir !== rightDir) return leftDir < rightDir ? -1 : 1;
  if (left.file.index !== right.file.index) return left.file.index - right.file.index;
  return firstHunkIndex(left) - firstHunkIndex(right);
}

function byDiffOrder(left, right) {
  const leftPart = left.parts[0];
  const rightPart = right.parts[0];
  if (leftPart.file.index !== rightPart.file.index) return leftPart.file.index - rightPart.file.index;
  return (leftPart.hunks[0]?.index ?? -1) - (rightPart.hunks[0]?.index ?? -1);
}

function folderOf(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

function firstHunkIndex(unit) {
  return unit.hunks.length === 0 ? -1 : unit.hunks[0].index;
}

// Two hunk runs of one file can land in the same slice. Merging them keeps one
// file header for both and keeps the slice in diff order.
function partsFrom(units) {
  const byFile = new Map();
  for (const unit of units) {
    const found = byFile.get(unit.file.index);
    if (found) found.hunks.push(...unit.hunks);
    else byFile.set(unit.file.index, { file: unit.file, hunks: [...unit.hunks] });
  }
  const parts = [...byFile.values()].sort((left, right) => left.file.index - right.file.index);
  for (const part of parts) {
    part.hunks.sort((left, right) => left.index - right.index);
    part.changed = part.hunks.reduce((sum, hunk) => sum + hunk.changed, 0);
    part.partial = part.hunks.length !== part.file.hunks.length;
  }
  return parts;
}

function batchesOf(slices, size) {
  const batches = [];
  for (let at = 0; at < slices.length; at += size) {
    batches.push(slices.slice(at, at + size).map((slice) => slice.id));
  }
  return batches;
}

/** The plan as plain data, ready for `manifest.json`. */
export function describePlan(plan) {
  return {
    target: plan.target,
    totalChanged: plan.total,
    sliceCount: plan.sliceCount,
    oversized: plan.oversized,
    batchSize: MAX_BATCH,
    batches: plan.batches,
    slices: plan.slices.map((slice) => ({
      id: slice.id,
      path: slice.path,
      changed: slice.changed,
      oversized: slice.oversized,
      files: slice.parts.map((part) => ({
        path: part.file.path,
        oldPath: part.file.oldPath,
        status: part.file.status,
        binary: part.file.binary,
        changed: part.changed,
        hunks: part.hunks.length,
        ofHunks: part.file.hunks.length,
        partial: part.partial,
        ...(part.partial ? { newLineRanges: part.hunks.map(newLineRange) } : {}),
      })),
    })),
  };
}

function newLineRange(hunk) {
  return hunk.newLines === 0 ? `${hunk.newStart}-${hunk.newStart}` : `${hunk.newStart}-${hunk.newStart + hunk.newLines - 1}`;
}

/**
 * Check the parse itself. An empty list means the records hold every byte of the
 * input and every hunk header agrees with the lines below it.
 *
 * The whole-diff check walks offsets with `startsWith`, so a diff of any size
 * never gets rebuilt as a second string in memory.
 */
export function checkParse(parsed) {
  const problems = [];
  let at = 0;
  if (!parsed.source.startsWith(parsed.preamble)) problems.push("the preamble is not the start of the diff");
  // A preamble that holds diff content means real changes sit outside every file
  // record, so no slice would carry them. A combined diff, from `diff --cc`,
  // lands here. Report it as a fault, not as a warning nobody reads.
  for (const line of parsed.preamble.split("\n")) {
    if (line.startsWith("diff --") || line.startsWith("@@")) {
      problems.push(`diff content before the first "diff --git" line, starting at: ${line}`);
      break;
    }
  }
  at += parsed.preamble.length;

  for (const file of parsed.files) {
    if (file.header + file.hunks.map((hunk) => hunk.text).join("") !== file.text) {
      problems.push(`${file.path}: header plus hunks do not rebuild the file section`);
    }
    let added = 0;
    let deleted = 0;
    for (const hunk of file.hunks) {
      if (hunk.countedOld !== hunk.oldLines || hunk.countedNew !== hunk.newLines) {
        problems.push(
          `${file.path}: "${hunk.headerLine}" promises ${hunk.oldLines} old and ${hunk.newLines} new lines ` +
            `but holds ${hunk.countedOld} and ${hunk.countedNew}`,
        );
      }
      added += hunk.added;
      deleted += hunk.deleted;
    }
    if (added !== file.added || deleted !== file.deleted) {
      problems.push(`${file.path}: file counts ${file.added}/${file.deleted} do not match its hunks ${added}/${deleted}`);
    }
    if (!parsed.source.startsWith(file.text, at)) {
      problems.push(`${file.path}: its record does not match the diff at byte ${at}`);
    }
    at += file.text.length;
  }

  if (at !== parsed.source.length) {
    problems.push(`the parsed records cover ${at} bytes, but the diff holds ${parsed.source.length}`);
  }
  return problems;
}

/**
 * Check a plan against the diff it came from. An empty list means every file
 * section and every hunk is in exactly one slice, the slice totals add up, every
 * slice is within the target unless one hunk forces it over, and the slices
 * rebuild each file section byte for byte.
 */
export function checkPlan(parsed, plan) {
  const problems = [];
  const seenFiles = new Map();
  let planned = 0;

  for (const slice of plan.slices) {
    let sliceChanged = 0;
    for (const part of slice.parts) {
      sliceChanged += part.changed;
      const record = seenFiles.get(part.file.index) ?? { sections: 0, hunks: [] };
      record.sections += 1;
      for (const hunk of part.hunks) record.hunks.push(hunk.index);
      seenFiles.set(part.file.index, record);
      if (part.changed !== part.hunks.reduce((sum, hunk) => sum + hunk.changed, 0)) {
        problems.push(`${slice.id}: ${part.file.path} reports ${part.changed} changed lines, which its hunks do not match`);
      }
    }
    if (sliceChanged !== slice.changed) {
      problems.push(`${slice.id}: reports ${slice.changed} changed lines, but its files hold ${sliceChanged}`);
    }
    if (slice.changed > plan.target && !slice.oversized) {
      problems.push(`${slice.id}: holds ${slice.changed} changed lines, over the target of ${plan.target}, yet no single hunk forces it`);
    }
    planned += sliceChanged;
  }

  if (planned !== parsed.totals.changed) {
    problems.push(`the slices hold ${planned} changed lines, but the diff holds ${parsed.totals.changed}`);
  }

  for (const file of parsed.files) {
    const record = seenFiles.get(file.index);
    if (!record) {
      problems.push(`${file.path}: missing from every slice`);
      continue;
    }
    if (file.hunks.length === 0 && record.sections !== 1) {
      problems.push(`${file.path}: has no hunks and appears in ${record.sections} slices`);
    }
    const ordered = [...record.hunks].sort((left, right) => left - right);
    const wanted = file.hunks.map((hunk) => hunk.index);
    if (ordered.length !== wanted.length || ordered.some((index, at) => index !== wanted[at])) {
      problems.push(`${file.path}: its ${wanted.length} hunk(s) appear as [${ordered.join(", ")}] across the slices`);
      continue;
    }
    const rebuilt = file.header + ordered.map((index) => file.hunks[index].text).join("");
    if (rebuilt !== file.text) problems.push(`${file.path}: the slice fragments do not rebuild the file section`);
  }

  for (const [index] of seenFiles) {
    if (index >= parsed.files.length) problems.push(`slice part points at file ${index}, which the diff does not hold`);
  }
  return problems;
}

function isHunkStart(line) {
  return line !== null && line.startsWith(HUNK_START);
}

function optionalCount(text) {
  return text === undefined ? 1 : Number(text);
}

function countLines(text) {
  let count = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count += 1;
  return text.endsWith("\n") ? count : count + 1;
}

// A one-line-at-a-time reader over the whole diff. It hands out offsets so every
// record can be a shared slice of the source instead of a fresh string.
class Cursor {
  constructor(source) {
    this.source = source;
    this.pos = 0;
    this.lineAt = -1;
    this.line = null;
    this.lineEnd = 0;
  }

  peek() {
    if (this.pos >= this.source.length) return null;
    if (this.lineAt !== this.pos) {
      const newline = this.source.indexOf("\n", this.pos);
      const stop = newline === -1 ? this.source.length : newline;
      this.line = this.source.slice(this.pos, stop);
      this.lineEnd = newline === -1 ? this.source.length : newline + 1;
      this.lineAt = this.pos;
    }
    return this.line;
  }

  take() {
    const line = this.peek();
    if (line === null) return null;
    this.pos = this.lineEnd;
    return line;
  }
}
