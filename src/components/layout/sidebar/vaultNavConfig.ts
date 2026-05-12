import { Cloud, HardDrive, type LucideIcon } from 'lucide-react';
import type { VaultProfileId } from '../../../vault/profileTypes';

export interface VaultNavItemConfig {
  id: VaultProfileId;
  label: string;
  icon: LucideIcon;
}

export const VAULT_NAV_ITEMS: ReadonlyArray<VaultNavItemConfig> = [
  {
    id: 'local',
    label: 'Local Vault',
    icon: HardDrive,
  },
  {
    id: 'google',
    label: 'Google Sync',
    icon: Cloud,
  },
];
