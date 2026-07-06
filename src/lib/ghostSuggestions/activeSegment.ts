/**
 * Active-segment parsing for multisegment shell lines (P4).
 * Mirrors `ghost/parser.rs::extract_search_prefix` separator logic so path
 * completion and cwd tracking suggest on the tail command, not the full line.
 */

const SHELL_WRAPPER_KEYWORDS = [
  'and ', 'or ', 'not ', 'if ', 'while ', 'begin ', 'command ', 'builtin ', 'exec ',
  'sudo ', 'doas ', 'time ', 'env ', 'noglob ',
] as const;

function stripShellKeywordsOnce(value: string): string {
  for (const keyword of SHELL_WRAPPER_KEYWORDS) {
    if (value.startsWith(keyword)) {
      return value.slice(keyword.length).trimStart();
    }
  }
  return value;
}

function stripShellKeywordsRecursive(value: string): string {
  let current = value;
  for (;;) {
    const next = stripShellKeywordsOnce(current);
    if (next === current) return current;
    current = next;
  }
}

function looksLikeEnvAssignment(token: string): boolean {
  const eq = token.indexOf('=');
  if (eq <= 0) return false;
  const key = token.slice(0, eq);
  const first = key.charCodeAt(0);
  if (first !== 95 && (first < 65 || first > 90) && (first < 97 || first > 122)) {
    return false;
  }
  for (let i = 1; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    if (ch !== 95 && (ch < 48 || ch > 57) && (ch < 65 || ch > 90) && (ch < 97 || ch > 122)) {
      return false;
    }
  }
  return true;
}

function stripLeadingAssignments(value: string): string {
  let current = value;
  for (;;) {
    const trimmed = current.trimStart();
    if (!trimmed) return trimmed;
    const nextWs = trimmed.search(/\s/);
    const boundary = nextWs === -1 ? trimmed.length : nextWs;
    const token = trimmed.slice(0, boundary);
    if (!looksLikeEnvAssignment(token)) return trimmed;
    current = trimmed.slice(boundary);
  }
}

/** Index after the last unquoted command separator (`;`, `|`, `||`, `&&`, newline). */
export function findActiveSegmentStart(line: string): number {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let segmentStart = 0;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;

    if (ch === '\n' || ch === '\r' || ch === ';') {
      segmentStart = i + 1;
      continue;
    }
    if (ch === '|') {
      segmentStart = i + 1;
      if (line[i + 1] === '|') {
        segmentStart = i + 2;
        i += 1;
      }
      continue;
    }
    if (ch === '&' && line[i + 1] === '&') {
      segmentStart = i + 2;
      i += 1;
    }
  }

  return segmentStart;
}

/** Tail command segment after the last separator, with wrappers/assignments stripped. */
export function extractActiveSegment(line: string): string {
  const segmentStart = findActiveSegmentStart(line);
  let segment = line.slice(segmentStart);
  segment = stripShellKeywordsRecursive(segment.trimStart());
  segment = stripLeadingAssignments(segment);
  return segment;
}

/** Line text used for command/path parsing (active segment when present). */
export function lineForSuggestionParsing(line: string): string {
  const segment = extractActiveSegment(line);
  return segment || line.trimStart();
}