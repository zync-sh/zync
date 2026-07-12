import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Shield } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import { cn } from '../../../lib/utils';
import { ZPortal } from '../../ui/ZPortal';
import { DEFAULT_VAULT_PROFILE_ID } from '../../../vault/profileTypes';
import { vaultIpc } from '../../../vault/ipc';
import { useVaultStore } from '../../../vault/useVaultStore';
import { isVaultInUseError } from '../../../vault/vaultLoading';
import { SplitSidebarActionButton } from './SplitSidebarActionButton';
import { VAULT_NAV_ITEMS } from './vaultNavConfig';

type VaultAttention = 'none' | 'setup' | 'secure' | 'locked' | 'ready';

/**
 * Badge only for *actionable* secure-to-vault candidates.
 * Hosts with missing key files are skipped by preview — they must not nag forever.
 */
function resolveVaultAttention(
    status: ReturnType<typeof useVaultStore.getState>['status'],
    error: ReturnType<typeof useVaultStore.getState>['error'],
    securableCount: number,
): { attention: VaultAttention; badge: string | number | null; badgeTitle?: string } {
    if (isVaultInUseError(error)) {
        return { attention: 'locked', badge: '!', badgeTitle: 'Vault open in another Zync window' };
    }
    const vaultReady = status?.status === 'locked' || status?.status === 'unlocked';
    if (!vaultReady) {
        if (securableCount > 0) {
            return {
                attention: 'setup',
                badge: 'Set up',
                badgeTitle: 'Set up Vault to encrypt host credentials on this device',
            };
        }
        return { attention: 'none', badge: null };
    }
    if (status?.status === 'locked') {
        return {
            attention: 'locked',
            badge: null,
            badgeTitle: 'Vault locked — unlock to use vault credentials',
        };
    }
    if (securableCount > 0) {
        return {
            attention: 'secure',
            badge: securableCount > 99 ? '99+' : securableCount,
            badgeTitle: `${securableCount} host${securableCount === 1 ? '' : 's'} with credentials ready to secure in vault`,
        };
    }
    return { attention: 'ready', badge: null };
}

function statusDotClass(
    status: ReturnType<typeof useVaultStore.getState>['status'],
    error: ReturnType<typeof useVaultStore.getState>['error'],
    securableCount: number,
): { className: string; title: string } {
    if (isVaultInUseError(error)) {
        return { className: 'bg-orange-500/80', title: 'Vault open in another Zync window' };
    }
    if (status?.status === 'unlocked') {
        if (securableCount > 0) {
            return {
                className: 'bg-amber-500/85',
                title: `${securableCount} host${securableCount === 1 ? '' : 's'} ready to secure`,
            };
        }
        return { className: 'bg-emerald-500/85', title: 'Local vault unlocked' };
    }
    if (status?.status === 'locked') {
        return { className: 'bg-amber-500/80', title: 'Local vault locked' };
    }
    return { className: 'bg-app-accent/70', title: 'Local vault not set up' };
}

const MENU_WIDTH = 192; // w-48

export function VaultNavSection() {
    const connections = useAppStore(state => state.connections);
    const openVaultTab = useAppStore(state => state.openVaultTab);
    const activeVaultProfileId = useAppStore(state => {
        const activeTab = state.tabs.find(tab => tab.id === state.activeTabId);
        if (activeTab?.type !== 'vault') return null;
        return activeTab.vaultProfileId ?? DEFAULT_VAULT_PROFILE_ID;
    });
    const vaultStatus = useVaultStore(state => state.status);
    const vaultError = useVaultStore(state => state.error);

    const [menuOpen, setMenuOpen] = useState(false);
    const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
    const triggerRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const [securableCount, setSecurableCount] = useState(0);

    const connectionsSignature = useMemo(
        () => connections
            .map(c => `${c.id}:${c.authRef?.credentialId ?? c.authRef?.itemId ?? ''}:${c.password ? 1 : 0}:${c.privateKeyPath ?? ''}`)
            .join('|'),
        [connections],
    );

    useEffect(() => {
        let cancelled = false;
        void vaultIpc.secureToVaultPreview()
            .then((preview) => {
                if (cancelled) return;
                const count = preview.candidates.filter(
                    c => c.secureKind === 'ssh-password' || c.secureKind === 'ssh-private-key',
                ).length;
                setSecurableCount(count);
            })
            .catch(() => {
                if (!cancelled) setSecurableCount(0);
            });
        return () => {
            cancelled = true;
        };
    }, [connectionsSignature, vaultStatus?.status]);

    const updateMenuPosition = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        // Same feel as topbar +: compact card under the trigger, left-aligned.
        let left = rect.left;
        let top = rect.bottom + 8;
        const maxLeft = window.innerWidth - MENU_WIDTH - 8;
        if (left > maxLeft) left = Math.max(8, maxLeft);
        const estimatedHeight = 48 + VAULT_NAV_ITEMS.length * 36;
        if (top + estimatedHeight > window.innerHeight - 8) {
            top = Math.max(8, rect.top - estimatedHeight - 8);
        }
        setMenuPos({ top, left });
    }, []);

    useLayoutEffect(() => {
        if (!menuOpen) {
            setMenuPos(null);
            return;
        }
        updateMenuPosition();
        window.addEventListener('resize', updateMenuPosition);
        // Capture scroll from sidebar ancestors so the floating menu tracks.
        window.addEventListener('scroll', updateMenuPosition, true);
        return () => {
            window.removeEventListener('resize', updateMenuPosition);
            window.removeEventListener('scroll', updateMenuPosition, true);
        };
    }, [menuOpen, updateMenuPosition]);

    useEffect(() => {
        if (!menuOpen) return;
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            if (triggerRef.current?.contains(target)) return;
            if (menuRef.current?.contains(target)) return;
            setMenuOpen(false);
        };
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setMenuOpen(false);
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [menuOpen]);

    const attentionState = useMemo(
        () => resolveVaultAttention(vaultStatus, vaultError, securableCount),
        [securableCount, vaultError, vaultStatus],
    );

    const localStatus = useMemo(
        () => statusDotClass(vaultStatus, vaultError, securableCount),
        [securableCount, vaultError, vaultStatus],
    );

    const openLocalVault = useCallback(() => {
        setMenuOpen(false);
        openVaultTab(DEFAULT_VAULT_PROFILE_ID);
    }, [openVaultTab]);

    const openVaultProfile = useCallback((profileId: typeof VAULT_NAV_ITEMS[number]['id']) => {
        setMenuOpen(false);
        openVaultTab(profileId);
    }, [openVaultTab]);

    return (
        <div className="relative w-full" ref={triggerRef}>
            <SplitSidebarActionButton
                icon={<Shield size={13} />}
                label="Vault"
                expanded={menuOpen}
                active={activeVaultProfileId === DEFAULT_VAULT_PROFILE_ID || menuOpen}
                attention={attentionState.attention}
                badge={attentionState.badge}
                badgeTitle={attentionState.badgeTitle}
                onPrimaryClick={openLocalVault}
                onToggleClick={() => setMenuOpen(open => !open)}
                toggleAriaLabel={menuOpen ? 'Close vault menu' : 'Open vault menu'}
            />

            {menuOpen && menuPos && (
                <ZPortal>
                    {/* Compact floating card — same chrome as topbar + menu */}
                    <div
                        ref={menuRef}
                        role="menu"
                        aria-label="Vault destinations"
                        style={{
                            position: 'fixed',
                            top: menuPos.top,
                            left: menuPos.left,
                            width: MENU_WIDTH,
                        }}
                        className={cn(
                            'z-[200] bg-app-panel border border-app-border rounded-xl shadow-2xl',
                            'overflow-hidden animate-in fade-in zoom-in-95 duration-150 p-1',
                        )}
                    >
                        {VAULT_NAV_ITEMS.map(item => {
                            const Icon = item.icon;
                            const isActive = activeVaultProfileId === item.id;
                            const showStatus = item.id === 'local';

                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => openVaultProfile(item.id)}
                                    className={cn(
                                        'w-full text-left px-3 py-2 text-xs font-medium text-app-text',
                                        'hover:bg-black/5 dark:hover:bg-white/10 rounded-lg',
                                        'flex items-center gap-2 transition-colors',
                                        isActive && 'bg-black/5 dark:bg-white/5',
                                    )}
                                >
                                    <Icon size={13} className="text-app-muted shrink-0" />
                                    <span className="truncate flex-1">{item.label}</span>
                                    {showStatus && (
                                        <span
                                            title={localStatus.title}
                                            className={cn(
                                                'h-1.5 w-1.5 rounded-full shrink-0',
                                                localStatus.className,
                                            )}
                                        />
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </ZPortal>
            )}
        </div>
    );
}
