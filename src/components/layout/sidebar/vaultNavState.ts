import type { AppSettings } from '../../../store/settingsSlice';

export function resolveVaultExpanded(settings: AppSettings): boolean {
  return settings.sidebarSections?.vaultExpanded ?? true;
}

export function nextSidebarSectionsForVaultToggle(
  settings: AppSettings,
  expanded: boolean,
): AppSettings['sidebarSections'] {
  return {
    ...settings.sidebarSections,
    vaultExpanded: !expanded,
  };
}
