export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

export interface SearchMatch {
  start: number;
  end: number;
  text: string;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildSearchRegex(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;

  try {
    let pattern = options.useRegex ? query : escapeRegex(query);
    if (options.wholeWord) {
      pattern = `\\b${pattern}\\b`;
    }
    const flags = options.caseSensitive ? 'g' : 'gi';
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function findMatches(content: string, query: string, options: SearchOptions): SearchMatch[] {
  const regex = buildSearchRegex(query, options);
  if (!regex) return [];

  return Array.from(content.matchAll(regex)).map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    text: match[0],
  }));
}

export function replaceMatch(
  content: string,
  match: SearchMatch,
  replacement: string,
): string {
  return `${content.slice(0, match.start)}${replacement}${content.slice(match.end)}`;
}

export function replaceAllMatches(
  content: string,
  matches: SearchMatch[],
  replacement: string,
): string {
  if (matches.length === 0) return content;

  let offset = 0;
  let nextContent = content;
  for (const match of matches) {
    const adjustedStart = match.start + offset;
    const adjustedEnd = match.end + offset;
    nextContent = `${nextContent.slice(0, adjustedStart)}${replacement}${nextContent.slice(adjustedEnd)}`;
    offset += replacement.length - (match.end - match.start);
  }
  return nextContent;
}
