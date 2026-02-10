export interface TunnelPreset {
    id: string;
    name: string;
    icon: string; // Lucide icon name
    description: string;
    type: 'local' | 'remote';
    localPort: number;
    remoteHost: string;
    remotePort: number;
    bindToAny?: boolean;
}

export const TUNNEL_PRESETS: TunnelPreset[] = [
    {
        id: 'mysql',
        name: 'MySQL',
        icon: 'Database',
        description: 'MySQL Database Server',
        type: 'local',
        localPort: 3306,
        remoteHost: 'localhost',
        remotePort: 3306,
    },
    {
        id: 'postgresql',
        name: 'PostgreSQL',
        icon: 'Database',
        description: 'PostgreSQL Database',
        type: 'local',
        localPort: 5432,
        remoteHost: 'localhost',
        remotePort: 5432,
    },
    {
        id: 'mongodb',
        name: 'MongoDB',
        icon: 'Database',
        description: 'MongoDB NoSQL Database',
        type: 'local',
        localPort: 27017,
        remoteHost: 'localhost',
        remotePort: 27017,
    },
    {
        id: 'redis',
        name: 'Redis',
        icon: 'Layers',
        description: 'Redis Cache Server',
        type: 'local',
        localPort: 6379,
        remoteHost: 'localhost',
        remotePort: 6379,
    },
    {
        id: 'http-dev',
        name: 'HTTP Dev',
        icon: 'Globe',
        description: 'HTTP Development Server',
        type: 'local',
        localPort: 8080,
        remoteHost: 'localhost',
        remotePort: 3000,
    },
    {
        id: 'https',
        name: 'HTTPS',
        icon: 'Lock',
        description: 'HTTPS Web Server',
        type: 'local',
        localPort: 443,
        remoteHost: 'localhost',
        remotePort: 443,
    },
];
