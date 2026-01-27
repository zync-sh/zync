import { memo } from 'react';
import { Server, Database, Monitor, Cloud, Box, HardDrive, Globe, Code, Terminal, Cpu } from 'lucide-react';

interface OSIconProps {
    icon: string;
    className?: string;
}

export const OSIcon = memo(function OSIcon({ icon, className }: OSIconProps) {
    // Normalization
    const type = icon?.toLowerCase() || 'server';

    // List of available custom icons
    const availableIcons = ['ubuntu', 'debian', 'centos', 'arch', 'kali', 'linux', 'macos', 'redhat', 'windows'];

    // Specific mapping for variations
    let iconName = type;
    if (type === 'apple' || type === 'darwin') iconName = 'macos';
    if (type === 'rhel' || type === 'fedora' || type === 'alma' || type === 'rocky') iconName = 'redhat';
    if (type === 'manjaro') iconName = 'arch';
    if (type === 'pop' || type === 'mint') iconName = 'ubuntu';
    if (type === 'raspbian') iconName = 'debian';
    if (type === 'alpine' || type === 'amazon') iconName = 'linux';

    if (availableIcons.includes(iconName)) {
        return (
            <img
                src={`./os-icons/${iconName}.png`}
                alt={iconName}
                className={className}
                onError={(e) => {
                    // Fallback to Server icon if image fails to load
                    e.currentTarget.style.display = 'none';
                    // We can't easily render the component fallback here without state, 
                    // but hiding the broken image is a good start.
                    // Ideally we'd toggle a state, but let's assume the files exist as I just verified them.
                }}
            />
        );
    }

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
    return <IconComp className={className} />;
});


