import { useEffect, useState, type ComponentType } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Activity, Cpu, Gauge, Globe, Layers, Lock, Monitor, Package, Plug, Settings as SettingsIcon, Shield, Terminal, Zap, FileText, Folder } from 'lucide-react';
import { clsx } from 'clsx';

interface IconResolverProps {
    name?: string;
    path?: string;
    size?: number;
    className?: string;
}

const icons: Record<string, ComponentType<{ size?: number; className?: string }>> = {
    Activity, Cpu, Gauge, Layers, Globe, Zap, Shield, Lock, Terminal, Package, Plug, FileText, Monitor, SettingsIcon, Folder
};

const iconAliases: Record<string, string> = {
    settings: 'SettingsIcon',
    setting: 'SettingsIcon',
    plugin: 'Plug',
    file: 'FileText',
};

const normalizeIconKey = (value: string): string => value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .replace(/icon$/, '');

const normalizedIcons = Object.entries(icons).reduce<Record<string, ComponentType<{ size?: number; className?: string }>>>((acc, [key, component]) => {
    const normalized = normalizeIconKey(key);
    if (!acc[normalized]) {
        acc[normalized] = component;
    }
    return acc;
}, {});

export function IconResolver({ name, path, size = 16, className = "" }: IconResolverProps) {
    const [imgError, setImgError] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        setImgError(false);
        setIsLoading(true);
    }, [name, path]);

    const normalizedName = name?.toLowerCase() ?? '';
    const isImage = Boolean(normalizedName) && (
        normalizedName.endsWith('.png')
        || normalizedName.endsWith('.svg')
        || normalizedName.endsWith('.jpg')
        || normalizedName.endsWith('.jpeg')
    );

    if (isImage && path && name && !imgError) {
        const unsafeName = name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0');
        const normalizedPath = path.replace(/\\/g, '/');
        const pathSegments = normalizedPath.split('/').filter(Boolean);
        const unsafePath = pathSegments.some((segment) => segment === '..') || normalizedPath.includes('\0');
        if (unsafeName || unsafePath) {
            return <Plug size={size} className={className} />;
        }
        const cleanPath = normalizedPath.endsWith('/') ? normalizedPath.slice(0, -1) : normalizedPath;
        const cleanName = name.startsWith('/') ? name.slice(1) : name;
        const fullPath = `${cleanPath}/${cleanName}`;
        const assetUrl = convertFileSrc(fullPath);

        return (
            <div className={clsx("relative overflow-hidden flex items-center justify-center rounded-sm bg-black/5", className)} style={{ width: size, height: size }}>
                {isLoading && <div className="absolute inset-0 animate-pulse bg-white/10" />}
                <img
                    src={assetUrl}
                    alt=""
                    className={clsx("w-full h-full object-contain transition-opacity duration-200", isLoading ? "opacity-0" : "opacity-100")}
                    onLoad={() => setIsLoading(false)}
                    onError={() => {
                        console.error('[PluginIcon] Load Error', { iconName: name });
                        setImgError(true);
                        setIsLoading(false);
                    }}
                />
            </div>
        );
    }

    const resolvedName = (name || '').trim();
    const canonical = resolvedName.replace(/\s+/g, '');
    const separatorPascal = resolvedName
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
    const separatorCanonical = separatorPascal.replace(/\s+/g, '');
    const capitalized = canonical ? canonical.charAt(0).toUpperCase() + canonical.slice(1) : '';
    const normalized = canonical.toLowerCase();
    const aliasTarget = iconAliases[normalized];
    const candidateKeys = [
        resolvedName,
        canonical,
        `${canonical}Icon`,
        capitalized,
        `${capitalized}Icon`,
        separatorPascal,
        `${separatorPascal}Icon`,
        separatorCanonical,
        `${separatorCanonical}Icon`,
        separatorPascal.toLowerCase(),
        aliasTarget,
    ].filter((value): value is string => Boolean(value));
    const Icon = candidateKeys
        .map((key) => normalizedIcons[normalizeIconKey(key)])
        .find(Boolean)
        || Plug;
    return <Icon size={size} className={className} />;
}

export type { IconResolverProps };
