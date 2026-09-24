import { resolveAppVersion, resolveSurveyArch, resolveSurveyPlatform } from '../survey/platform.js';
import { isUsageFeatureId } from './catalog.js';
import { submitUsage } from './client.js';
import { isUsageEnabled } from './enabled.js';
import { getOrCreateInstallId } from './identity.js';
import {
  dropPendingDay,
  loadQueue,
  markCurrentFlushed,
  saveQueue,
  type UsageDayQueue,
} from './queue.js';
import { dayOpenSeconds, ensureUsageSession, sessionPayload } from './session.js';
import type { UsagePayload } from './types.js';

const FLUSH_INTERVAL_MS = 15 * 60 * 1000;

let flushing = false;
let cachedVersion = '';

async function toPayload(day: UsageDayQueue, now = new Date()): Promise<UsagePayload> {
  if (!cachedVersion) {
    cachedVersion = await resolveAppVersion();
  }
  const features = Object.entries(day.features).flatMap(([id, count]) => {
    if (!isUsageFeatureId(id) || !count) return [];
    return [{ id, count }];
  });
  const payload: UsagePayload = {
    schemaVersion: 1,
    installId: getOrCreateInstallId(),
    day: day.day,
    appVersion: cachedVersion || undefined,
    platform: resolveSurveyPlatform(),
    arch: resolveSurveyArch(),
    features,
  };
  if (day.day === now.toISOString().slice(0, 10)) {
    const session = ensureUsageSession(now);
    payload.openSeconds = dayOpenSeconds(session, day.day, now);
    payload.sessions = [sessionPayload(session, day.day, now)];
  } else if (day.sessions?.length || day.openSeconds != null) {
    payload.openSeconds = day.openSeconds;
    payload.sessions = day.sessions;
  }
  return payload;
}

export async function flushUsage(forceCurrent = false): Promise<void> {
  if (!isUsageEnabled() || flushing) return;
  flushing = true;
  try {
    const snapshot = loadQueue();
    for (const pending of snapshot.pending) {
      if (!pending.dirty) continue;
      await submitUsage(await toPayload(pending));
      saveQueue(dropPendingDay(loadQueue(), pending.day));
      if (!isUsageEnabled()) return;
    }
    if (!isUsageEnabled()) return;
    const due = forceCurrent
      || snapshot.current.dirty
      || snapshot.lastFlushAt == null
      || (Date.now() - snapshot.lastFlushAt) >= FLUSH_INTERVAL_MS;
    if (!due) return;
    const sent = snapshot.current;
    await submitUsage(await toPayload(sent));
    saveQueue(markCurrentFlushed(loadQueue(), sent));
  } catch {
    // Keep dirty flags; retry on next open / interval / close.
  } finally {
    flushing = false;
  }
}

export { FLUSH_INTERVAL_MS };
