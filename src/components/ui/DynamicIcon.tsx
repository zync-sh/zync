import { memo, useState, useEffect, useMemo, useRef } from 'react';
import { getIconID, resolveIconResource, CATEGORY_FALLBACK_MAP } from '../../lib/icons/icon-map';
import { getCachedIcon } from '../../lib/icons/iconCache';
import { Server, File, Folder, Terminal, Settings, Lock, FileCode, Archive, Database, Image } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAppStore } from '../../store/useAppStore';
import { usePlugins } from '../../context/PluginContext';

interface DynamicIconProps {
    type: string; // Filename, extension, or specific icon ID
    size?: number;
    className?: string;
    isFolder?: boolean;
}

export const DynamicIcon = memo(function DynamicIcon({
    type,
    size = 14,
    className,
    isFolder = false
}: DynamicIconProps) {
    const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
    const [error, setError] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);
    const [fallbackLevel, setFallbackLevel] = useState(0); // 0: Specific, 1: Category, 2: Final
    
    /** After local convertFileSrc URL fails, try remote once */
    const triedRemoteAfterLocalFailure = useRef(false);

    const iconTheme = useAppStore((s) => s.settings.iconTheme);
    const { plugins } = usePlugins();

    const activePlugin = useMemo(() => {
        if (iconTheme === 'vscode-icons' || iconTheme === 'lucide') return null;
        return plugins.find(p => p.manifest.id === iconTheme && p.manifest.type === 'icon-theme');
    }, [iconTheme, plugins]);

    // Calculate current icon ID based on fallback level
    const currentIconID = useMemo(() => {
        const baseID = isFolder ? `folder_type_${type}` : getIconID(type, iconTheme);
        
        // Only attempt category fallback for files (not folders)
        if (!isFolder && fallbackLevel === 1) {
            const rawID = baseID.startsWith('file_type_') ? baseID.slice(10) : baseID;
            const category = CATEGORY_FALLBACK_MAP[rawID];
            if (category) return `file_type_${category}`;
        }
        
        return baseID;
    }, [type, isFolder, fallbackLevel, iconTheme]);

    const pluginIconsPath = activePlugin?.manifest?.iconsPath
        ?? (activePlugin?.manifest as { icons_path?: string } | undefined)?.icons_path;

    const themeResource = useMemo(() => resolveIconResource(
        currentIconID,
        iconTheme,
        activePlugin?.path,
        pluginIconsPath
    ), [currentIconID, iconTheme, activePlugin, pluginIconsPath]);

    const localSrc = themeResource.local;
    const remoteSrc = themeResource.remote;

    /** Shared helper to handle icon loading failures (404s, network errors) */
    const attemptFallback = (isCancelled: boolean) => {
        if (isCancelled) return;
        
        // If at level 0 and a category fallback exists, try level 1
        const rawID = currentIconID.startsWith('file_type_') ? currentIconID.slice(10) : currentIconID;
        if (fallbackLevel === 0 && !isFolder && CATEGORY_FALLBACK_MAP[rawID]) {
            setFallbackLevel(1);
        } else {
            setError(true);
        }
    };

    useEffect(() => {
        let isCancelled = false;
        
        // Reset state on type/theme/fallback change
        setIsLoaded(false);
        if (fallbackLevel === 0) {
            setError(false);
            setResolvedSrc(null);
            triedRemoteAfterLocalFailure.current = false;
        }

        if (iconTheme === 'lucide') return;

        const loadIcon = async () => {
            try {
                if (localSrc) {
                    if (!isCancelled) setResolvedSrc(localSrc);
                } else if (remoteSrc) {
                    const src = await getCachedIcon(remoteSrc);
                    if (!isCancelled) setResolvedSrc(src);
                } else {
                    attemptFallback(isCancelled);
                }
            } catch (err) {
                if (remoteSrc) {
                    try {
                        const src = await getCachedIcon(remoteSrc);
                        if (!isCancelled) setResolvedSrc(src);
                    } catch (remoteErr) {
                        attemptFallback(isCancelled);
                    }
                } else {
                    attemptFallback(isCancelled);
                }
            }
        };

        loadIcon();
        return () => { isCancelled = true; };
    }, [currentIconID, iconTheme, localSrc, remoteSrc]);

    // Reset fallback level when connection or type changes
    useEffect(() => {
        setFallbackLevel(0);
        setError(false);
        setIsLoaded(false);
        setResolvedSrc(null);
    }, [type, isFolder, iconTheme]);

    const getFallbackIcon = () => {
        if (isFolder) return Folder;
        if (type === 'connection') return Server;
        const lower = type.toLowerCase();
        if (lower.startsWith('.') || ['sh', 'bash', 'zsh', 'fish', 'ps1'].includes(lower)) return Terminal;
        
        // System / Binary / Executable group
        if (
            lower.includes('config') || 
            ['yml', 'yaml', 'toml', 'ini', 'json'].includes(lower) ||
            ['exe', 'msi', 'apk', 'appimage', 'bin', 'iso', 'img', 'dll', 'so'].includes(lower)
        ) return Settings;

        if (lower.includes('key') || lower.includes('id_') || ['pem', 'pub', 'key', 'crt'].includes(lower)) return Lock;
        if (['zip', 'tar', 'gz', 'rar', '7z'].includes(lower)) return Archive;
        if (['db', 'sqlite', 'sql'].includes(lower)) return Database;
        if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(lower)) return Image;
        if (['js', 'ts', 'py', 'go', 'rs', 'c', 'cpp'].includes(lower)) return FileCode;
        return File;
    };

    const FallbackIcon = getFallbackIcon();

    // The logic below ensures that the img is only displayed once it is confirmed loaded. 
    // If it's not loaded, we show the themed Lucide fallback. 
    // This absolutely prevents "broken image" boxes from appearing.
    const showFallback = iconTheme === 'lucide' || error || !resolvedSrc || !isLoaded;

    return (
        <div style={{ width: size, height: size }} className={cn("relative flex items-center justify-center", className)}>
            {showFallback && (
                <FallbackIcon size={size} className="text-app-muted/60 shrink-0 absolute inset-0" />
            )}
            {resolvedSrc && (
                <img
                    src={resolvedSrc}
                    alt={type}
                    style={{ width: size, height: size }}
                    className={cn(
                        "shrink-0 select-none transition-opacity duration-200", 
                        isLoaded ? "opacity-100" : "opacity-0"
                    )}
                    draggable={false}
                    onLoad={() => setIsLoaded(true)}
                    onError={() => {
                        setIsLoaded(false);
                        if (remoteSrc && !triedRemoteAfterLocalFailure.current) {
                            triedRemoteAfterLocalFailure.current = true;
                            getCachedIcon(remoteSrc).then(src => {
                                setResolvedSrc(src);
                            }).catch(() => {
                                attemptFallback(false);
                            });
                        } else {
                            attemptFallback(false);
                        }
                    }}
                />
            )}
        </div>
    );
});
