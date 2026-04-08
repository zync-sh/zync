export function getCodeMirrorLanguageId(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'js':
      return 'javascript';
    case 'jsx':
      return 'javascript-jsx';
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'typescript-jsx';
    case 'json':
      return 'json';
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
      return 'css';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'xml':
    case 'svg':
      return 'xml';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'sql':
      return 'sql';
    default:
      return 'plaintext';
  }
}

export function getLanguageLabel(filename: string): string {
  const extRaw = filename.split('.').pop() || 'TEXT';
  return extRaw.toUpperCase();
}

export function getLineCommentToken(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'sql':
      return '--';
    case 'py':
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'yml':
    case 'yaml':
    case 'toml':
    case 'ini':
    case 'conf':
    case 'rb':
      return '#';
    case 'css':
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
    case 'md':
    case 'markdown':
      return '';
    default:
      return '//';
  }
}
