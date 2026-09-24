import { isUsageFeatureId, type UsageFeatureId } from './catalog.js';
import { isUsageEnabled } from './enabled.js';
import { bumpFeature, loadQueue, saveQueue } from './queue.js';

export function track(feature: UsageFeatureId): void {
  if (!isUsageEnabled()) return;
  if (!isUsageFeatureId(feature)) return;
  saveQueue(bumpFeature(loadQueue(), feature));
}

export function trackConnectSuccess(host: {
  privateKeyPath?: string;
  password?: string;
  authRef?: { itemKind?: string };
} | undefined): void {
  track('connect_ok');
  const kind = host?.authRef?.itemKind;
  if (kind === 'ssh-private-key' || kind === 'ssh-agent-key' || host?.privateKeyPath) {
    track('auth_key');
    return;
  }
  if (kind === 'ssh-password' || host?.password) track('auth_password');
}

export function trackConnectFailure(): void {
  track('connect_fail');
}

export function usageFeatureForTabView(view: string | undefined): UsageFeatureId | null {
  if (!view) return null;
  if (view === 'files') return 'files';
  if (view === 'port-forwarding') return 'tunnels';
  if (view === 'dashboard') return 'dashboard';
  if (view === 'snippets') return 'snippets';
  if (view === 'terminal') return 'terminal';
  if (view.startsWith('plugin:')) return 'plugins';
  return null;
}
