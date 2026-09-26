import { defaultUrlTransform } from 'react-markdown';

/** Apply react-markdown's protocol gate to release-note links and media. */
export function releaseNotesUrlTransform(url: string): string {
  return defaultUrlTransform(url);
}
