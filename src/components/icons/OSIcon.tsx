import { memo, useState, useEffect } from 'react';
import { Server, Database, Monitor, Cloud, Box, HardDrive, Globe, Code, Terminal, Cpu } from 'lucide-react';

interface OSIconProps {
    icon: string;
    className?: string;
}

export const OSIcon = memo(function OSIcon({ icon, className }: OSIconProps) {
    // Normalization
    const type = icon?.toLowerCase() || 'server';

    // List of available custom icons
    const availableIcons = [
        'ubuntu', 'debian', 'centos', 'arch', 'kali', 'linux', 'macos', 'redhat', 'windows',
        'aws', 'jenkins', 'mongodb', 'nginx', 'postgresql', 'database', "mysql"
    ];

    // Icons that use SVG format
    const svgIcons = ['aws', 'jenkins', 'mongodb', "mysql"];

    // Specific mapping for variations
    let iconName = type;
    if (type === 'apple' || type === 'darwin') iconName = 'macos';
    if (type === 'rhel' || type === 'fedora' || type === 'alma' || type === 'rocky') iconName = 'redhat';
    if (type === 'manjaro') iconName = 'arch';
    if (type === 'pop' || type === 'mint') iconName = 'ubuntu';
    if (type === 'raspbian') iconName = 'debian';
    if (type === 'alpine' || type === 'amazon') iconName = 'linux';

    const [imageError, setImageError] = useState(false);

    // Reset error if icon changes
    useEffect(() => {
        setImageError(false);
    }, [icon]);

    // Default Mapping for Lucide Icons
    const IconMap: any = {
        server: Server,
        database: Database,
        monitor: Monitor,
        cloud: Cloud,
        box: Box,
        harddrive: HardDrive,
        globe: Globe,
        code: Code,
        terminal: Terminal,
        cpu: Cpu
    };

    const IconComp = IconMap[type] || Server;
    const isCustom = availableIcons.includes(iconName);
    const showImage = isCustom && !imageError;

    if (showImage) {
        const extension = svgIcons.includes(iconName) ? 'svg' : 'png';
        return (
            <img
                src={`/os-icons/${iconName}.${extension}`}
                alt={iconName}
                className={className}
                onError={() => setImageError(true)}
            />
        );
    }

    return <IconComp className={className} />;
});
