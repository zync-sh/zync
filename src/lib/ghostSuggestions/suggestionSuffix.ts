/**
 * Normalize ghost suffix spacing against the full typed line.
 * When the line does not end with whitespace, word completions need a leading
 * space; when it already ends with whitespace, strip duplicate leading space.
 */
export function normalizeSuggestionSuffix(line: string, suffix: string): string {
  if (!suffix) return suffix;

  const endsWithSpace = /[ \t]$/.test(line);
  const startsWithSpace = /^[ \t]/.test(suffix);

  if (endsWithSpace) {
    return startsWithSpace ? suffix.replace(/^[ \t]+/, '') : suffix;
  }
  if (startsWithSpace) return suffix;

  // Path, flag, and mid-token completions glue directly to the cursor.
  if (/^[/\\~.-]/.test(suffix)) return suffix;
  if (!/\s/.test(suffix)) return suffix;

  return ` ${suffix}`;
}