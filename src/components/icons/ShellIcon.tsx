import { memo, useState, useEffect, useMemo } from 'react';
import { Terminal as TerminalIcon } from 'lucide-react';
import type { ShellEntry } from '../../lib/shells/types';

interface ShellIconProps {
    shell: ShellEntry;
    size?: number;
}

/** CSS badge fallback — used when no image asset is available. */
function ShellBadge({ shellId, size }: { shellId: string; size: number }) {
    const badgeStyle = { width: size, height: size };
    const compactFont = { fontSize: Math.max(7, Math.floor(size * 0.5)) };
    const letterFont = { fontSize: Math.max(8, Math.floor(size * 0.64)) };
    const iconSize = Math.max(10, size - 1);

    if (shellId === 'powershell') {
        return <span style={{ ...badgeStyle, ...compactFont }} className="inline-flex rounded-sm bg-[#012456] items-center justify-center shrink-0 font-black text-white leading-none">PS</span>;
    }
    if (shellId === 'pwsh') {
        return <span style={{ ...badgeStyle, ...compactFont }} className="inline-flex rounded-sm bg-blue-500 items-center justify-center shrink-0 font-black text-white leading-none">PS</span>;
    }
    if (shellId === 'cmd') {
        return <TerminalIcon size={iconSize} className="shrink-0 text-yellow-500" />;
    }
    if (shellId === 'gitbash') {
        return <TerminalIcon size={iconSize} className="shrink-0 text-orange-400" />;
    }
    if (shellId.startsWith('wsl')) {
        const distro = shellId.startsWith('wsl:') ? shellId.slice(4).toLowerCase() : '';
        if (distro.includes('ubuntu')) {
            return <span style={{ ...badgeStyle, ...compactFont }} className="inline-flex rounded-full bg-[#E95420] items-center justify-center shrink-0 font-black text-white leading-none">U</span>;
        }
        if (distro.includes('debian')) {
            return <span style={{ ...badgeStyle, ...compactFont }} className="inline-flex rounded-full bg-red-600 items-center justify-center shrink-0 font-black text-white leading-none">D</span>;
        }
        if (distro.includes('kali')) {
            return <span style={{ ...badgeStyle, ...compactFont }} className="inline-flex rounded-full bg-blue-700 items-center justify-center shrink-0 font-black text-white leading-none">K</span>;
        }
        return <TerminalIcon size={iconSize} className="shrink-0 text-purple-400" />;
    }
    if (shellId.includes('zsh')) {
        return <span style={{ ...badgeStyle, ...letterFont }} className="inline-flex items-center justify-center shrink-0 font-black text-app-muted leading-none">Z</span>;
    }
    if (shellId.includes('fish')) {
        return <span style={{ ...badgeStyle, ...letterFont }} className="inline-flex items-center justify-center shrink-0 font-black text-sky-400 leading-none">F</span>;
    }
    if (shellId.includes('bash')) {
        return <TerminalIcon size={iconSize} className="shrink-0 text-green-500" />;
    }
    return <TerminalIcon size={iconSize} className="shrink-0 opacity-60" />;
}

/**
 * Displays the icon for a shell entry.
 *
 * Resolution order:
 *   1. base64Png  — PNG frame extracted from distro's shortcut.ico (modern WSL distros)
 *   2. base64Icon — raw ICO bytes for BMP-only distro icons (older WSL distros)
 *   3. bundled    — static file from /shell-icons/ (PowerShell, Git Bash, generic WSL…)
 *   4. ShellBadge — CSS letter/colour badge, always renders (no assets needed)
 *
 * img onError advances from step 1/2/3 to ShellBadge automatically.
 */
export const ShellIcon = memo(function ShellIcon({ shell, size = 14 }: ShellIconProps) {
    const [imgFailed, setImgFailed] = useState(false);
    const baseUrl = import.meta.env.BASE_URL || '/';
    const iconKey = useMemo(() => {
        if (!shell.icon) return 'none';
        if (shell.icon.type === 'bundled') return `bundled:${shell.icon.name}`;
        return `${shell.icon.type}:${shell.icon.data.length}`;
    }, [shell.icon]);

    useEffect(() => {
        setImgFailed(false);
    }, [shell.id, iconKey]);

    if (!imgFailed && shell.icon) {
        const src = shell.icon.type === 'base64Png'
            ? `data:image/png;base64,${shell.icon.data}`
            : shell.icon.type === 'base64Icon'
            ? `data:image/x-icon;base64,${shell.icon.data}`
            : (typeof shell.icon.name === 'string' && shell.icon.name.trim().length > 0
                ? new URL(`shell-icons/${shell.icon.name}`, window.location.origin + baseUrl).toString()
                : undefined);
        if (src) {
            return (
                <img
                    src={src}
                    width={size}
                    height={size}
                    className="shrink-0 rounded-sm object-contain"
                    onError={() => setImgFailed(true)}
                    alt=""
                />
            );
        }
    }

    return <ShellBadge shellId={shell.id} size={size} />;
});
