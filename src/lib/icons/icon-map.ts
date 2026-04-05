/**
 * Comprehensive Mapping of connections, OS, and file types to vscode-icons IDs.
 * Derived from vscode-icons repository (supportedExtensions.ts).
 */

const EXTENSION_MAP: Record<string, string> = {
    // Languages & Tools (Extensions)
    'rs': 'rust',
    'js': 'js',
    'ts': 'typescript',
    'tsx': 'typescriptreact',
    'jsx': 'reactjs',
    'py': 'python',
    'go': 'go',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'cppheader',
    'java': 'java',
    'json': 'json',
    'md': 'markdown',
    'html': 'html',
    'css': 'css',
    
    // System & Shell (Crucial for Zync)
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'fish': 'shell',
    'ksh': 'shell',
    'ps1': 'powershell',
    'bat': 'bat',
    'cmd': 'bat',
    'awk': 'awk',
    
    // Configuration & Data
    'yml': 'yaml',
    'yaml': 'yaml',
    'toml': 'toml',
    'conf': 'config',
    'cfg': 'config',
    'ini': 'config',
    'properties': 'config',
    'env': 'dotenv',
    'xml': 'xml',
    'sql': 'sql',
    'db': 'db',
    'sqlite': 'sqlite',
    
    // Security & SSH
    'key': 'key',
    'pub': 'key',
    'pem': 'key',
    'crt': 'cert',
    'cer': 'cert',
    'ca-bundle': 'cert',
    'gpg': 'gpg',
    
    // Archives & Compressed
    'zip': 'zip',
    'rar': 'zip',
    '7z': 'zip',
    'tar': 'zip',
    'gz': 'zip',
    'bz2': 'zip',
    'xz': 'zip',
    'tgz': 'zip',
    'tar.gz': 'zip',
    'tar.xz': 'zip',
    'tar.bz2': 'zip',
    
    // Executables & Binaries
    'exe': 'exe',
    'msi': 'windows',
    'apk': 'android',
    'deb': 'debian', // 'file_type_debian.svg' exists
    'rpm': 'linux',
    'appimage': 'linux',
    'dmg': 'apple',
    'pkg': 'apple',
    'iso': 'iso',
    'img': 'binary',
    'dll': 'binary',
    'bin': 'binary',
    'so': 'binary',
    'o': 'binary',
    'app': 'binary',
    'dat': 'binary',
    
    // Web & Media
    'svg': 'svg',
    'png': 'image',
    'jpg': 'image',
    'jpeg': 'image',
    'gif': 'image',
    'webp': 'image',
    'ico': 'favicon',
    'mp3': 'audio',
    'wav': 'audio',
    'flac': 'audio',
    'mp4': 'video',
    'mkv': 'video',
    'avi': 'video',
    'mov': 'video',
    'pdf': 'pdf',
    
    // Documents
    'txt': 'text',
    'log': 'log',
    'csv': 'csv',
    'doc': 'word',
    'docx': 'word',
    'xls': 'excel',
    'xlsx': 'excel',
    'ppt': 'powerpoint',
    'pptx': 'powerpoint',
    
    // Modern Dev
    'swift': 'swift',
    'kt': 'kotlin',
    'dart': 'dartlang',
    'vue': 'vue',
    'svelte': 'svelte',
    'graphql': 'graphql',
    'prisma': 'prisma',
    'dockerfile': 'docker',
    'docker': 'docker',
    'git': 'git',
    'cmake': 'cmake',
};

const FILENAME_MAP: Record<string, string> = {
    // Docker & Containerization
    'dockerfile': 'docker',
    'docker-compose.yml': 'docker',
    'docker-compose.yaml': 'docker',
    '.dockerignore': 'docker',
    
    // Node & Package Managers
    'package.json': 'node',
    'package-lock.json': 'node',
    'yarn.lock': 'yarn',
    'pnpm-lock.yaml': 'pnpm',
    'tsconfig.json': 'tsconfig',
    'jsconfig.json': 'jsconfig',
    'pnpm-workspace.yaml': 'pnpm',
    '.yarnrc': 'yarn',
    
    // Shell & Environment (Crucial for Zync)
    '.bashrc': 'shell',
    '.zshrc': 'shell',
    '.bash_profile': 'shell',
    '.profile': 'shell',
    '.zprofile': 'shell',
    '.bash_history': 'text', // History is just text
    '.zsh_history': 'text',
    '.env': 'dotenv',
    '.env.local': 'dotenv',
    '.env.development': 'dotenv',
    '.env.production': 'dotenv',
    'makefile': 'makefile',
    'rakefile': 'ruby',
    'procfile': 'procfile',
    
    // Git & Version Control
    '.gitignore': 'git',
    '.gitconfig': 'git',
    '.gitattributes': 'git',
    '.gitmodules': 'git',
    
    // Config & Project Meta
    '.editorconfig': 'editorconfig',
    '.eslintrc': 'eslint',
    '.eslintrc.json': 'eslint',
    '.eslintrc.js': 'eslint',
    '.prettierrc': 'prettier',
    'README.md': 'markdown',
    'LICENSE': 'license',
    'CHANGELOG.md': 'markdown',
    'cargo.toml': 'cargo',
    'cargo.lock': 'cargo',
    'composer.json': 'composer',
    'composer.lock': 'composer',
    'gemfile': 'ruby',
    '.npmrc': 'npm',
};

/**
 * Mapping of specialized icon IDs to their generic category fallbacks.
 * Used by the UI engine to attempt specialized icons before falling back to categories.
 */
export const CATEGORY_FALLBACK_MAP: Record<string, string> = {
    'android': 'binary',
    'ios': 'binary',
    'windows': 'binary',
    'linux': 'binary',
    'apple': 'binary',
    'iso': 'binary',
    'exe': 'binary',
    'cert': 'key',
};

import { convertFileSrc } from '@tauri-apps/api/core';

/** Strip traversal and normalize plugin-relative icon directory segments */
function sanitizeIconsPathSegment(path: string): string {
    return path
        .split(/[/\\]+/)
        .filter((s) => s.length > 0 && s !== '.' && s !== '..')
        .join('/');
}

/** vscode-icons filenames are alphanumerics, underscore, dot; block path injection from remote names */
function toSafeIconFilename(iconID: string): string {
    const raw = iconID.endsWith('.svg') ? iconID.slice(0, -4) : iconID;
    const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return `${safe || 'default_file'}.svg`;
}

/**
 * Returns the best-matching vscode-icons ID for a given string (type, extension, or filename)
 */
export function getIconID(name: string, themeId: string = 'vscode-icons'): string {
    const lower = name.toLowerCase();
    
    // For 'lucide' theme, we just return the name and let the component handle it with its fallback
    if (themeId === 'lucide') return name;

    // 1. Try Filename Match (exact) - highest priority
    if (FILENAME_MAP[lower]) {
        return `file_type_${FILENAME_MAP[lower]}`;
    }

    // 2. Try Extension Match
    const extArr = lower.split('.');
    if (extArr.length > 2) {
        // Try double extension first (e.g., .tar.gz)
        const doubleExt = `${extArr[extArr.length - 2]}.${extArr[extArr.length - 1]}`;
        if (EXTENSION_MAP[doubleExt]) {
            return `file_type_${EXTENSION_MAP[doubleExt]}`;
        }
    }
    
    const ext = extArr.length > 1 ? extArr.pop() || '' : '';
    if (ext && EXTENSION_MAP[ext]) {
        return `file_type_${EXTENSION_MAP[ext]}`;
    }

    // 3. Selective Heuristics (for unmatched files)
    if (lower.includes('history')) return 'file_type_text';
    if (lower.includes('log')) return 'file_type_log';
    if (lower.includes('key') || lower.includes('id_')) return 'file_type_key';

    // Default dotfiles to config icons instead of shell (Config is neutral gear-on-document)
    if (lower.startsWith('.')) return 'file_type_config';
    if (lower.includes('config')) return 'file_type_config';

    // 4. Final Fallback
    // NOTE: 'default_file' is an exception in vscode-icons as it does not follow
    // the 'file_type_' prefix convention (it maps directly to default_file.svg).
    return 'default_file';
}

/**
 * Resolves the final resource path for an icon based on the active theme.
 */
export function resolveIconResource(
    iconID: string, 
    themeId: string, 
    pluginPath?: string, 
    iconsPath?: string
): { local?: string; remote?: string } {
    if (themeId === 'lucide') return {};

    const filename = toSafeIconFilename(iconID);

    // 1. Handle Plugin Themes (real disk paths only — not builtin:// virtual roots)
    if (pluginPath && iconsPath && !pluginPath.startsWith('builtin://')) {
        const safeIconsPath = sanitizeIconsPathSegment(iconsPath);
        const fullPath = `${pluginPath}/${safeIconsPath}/${filename}`.replace(/\\/g, '/');
        return { local: convertFileSrc(fullPath) };
    }

    // 2. Handle System 'vscode-icons'
    if (themeId === 'vscode-icons' || themeId === 'system') {
        const remote = `https://raw.githubusercontent.com/vscode-icons/vscode-icons/master/icons/${filename}`;

        // VSCode icons are resolved to remote GitHub URLs here.
        // NOTE: The DynamicIcon component (UI Engine) handles the actual 
        // local caching of these URLs to ensure full offline availability.
        return { remote };
    }

    return {};
}
