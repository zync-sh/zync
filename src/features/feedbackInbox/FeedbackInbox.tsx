import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Bug } from "lucide-react";
import { Modal } from "../../components/ui/Modal";
import { useAppStore } from "../../store/useAppStore";
import { getExistingInstallId } from "../installation/identity";
import {
  claimLegacySurveys,
  fetchInbox,
  feedbackInboxEnabled,
  INBOX_OPEN_EVENT,
  INBOX_REFRESH_EVENT,
  setInboxStream,
  type InboxSnapshot,
} from "./client";
import { InboxHistory } from "./InboxHistory";
import { setInboxUnreadCount } from "./status";

const empty: InboxSnapshot = {
  threads: [],
  unread: 0,
  active: false,
  nextBefore: 0,
};
const LEGACY_CLAIMED_KEY = "zync.feedbackInbox.legacyClaimedInstallId";

function previouslyClaimed(installId: string | null): boolean {
  if (!installId) return true;
  try {
    return localStorage.getItem(LEGACY_CLAIMED_KEY) === installId;
  } catch {
    return false;
  }
}

/** One app-level coordinator owns SSE and unread state independently of settings
 * or tab mounting. No polling interval and no startup credential enrollment.
 */
export function FeedbackInbox() {
  const openSettings = useAppStore((state) => state.openSettings);
  const [snapshot, setSnapshot] = useState(empty);
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [legacyInstallId] = useState(getExistingInstallId);
  const [legacyClaimed, setLegacyClaimed] = useState(() => previouslyClaimed(legacyInstallId));
  const [claiming, setClaiming] = useState(false);
  const [claimResult, setClaimResult] = useState("");
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!feedbackInboxEnabled) return;
    let disposed = false,
      running = false,
      pending = false;
    let streaming = false;
    let online = navigator.onLine;
    const refresh = async () => {
      if (disposed) return;
      if (!online) return;
      if (running) {
        pending = true;
        return;
      }
      running = true;
      do {
        pending = false;
        try {
          // Native snapshot loading checks the build gate and returns an empty
          // inbox without creating credentials for installations not enrolled yet.
          const next = await fetchInbox();
          if (disposed || !online) break;
          setSnapshot(next);
          setInboxUnreadCount(next.unread);
          setRevision((value) => value + 1);
          setError("");
          if (next.active !== streaming) {
            await setInboxStream(next.active);
            if (disposed || !online) break;
            streaming = next.active;
          }
        } catch (err) {
          if (!disposed) {
            setError(String(err));
          }
        }
      } while (pending && !disposed);
      running = false;
    };
    refreshRef.current = () => {
      void refresh();
    };
    const changed = () => {
      void refresh();
    };
    const disconnected = () => {
      streaming = false;
      if (!disposed)
        setError(
          "Live reply delivery is disconnected. Open or refresh the inbox to reconnect.",
        );
    };
    const show = () => {
      setOpen(true);
      changed();
    };
    const resume = () => {
      online = true;
      streaming = false;
      changed();
    };
    const pause = () => {
      online = false;
      streaming = false;
      void setInboxStream(false).catch(() => {});
    };
    const subscriptions = [
      listen("feedback-inbox-changed", changed),
      listen("feedback-inbox-disconnected", disconnected),
    ];
    window.addEventListener(INBOX_REFRESH_EVENT, changed);
    window.addEventListener(INBOX_OPEN_EVENT, show);
    window.addEventListener("online", resume);
    window.addEventListener("offline", pause);
    void Promise.all(subscriptions)
      .then(() => {
        if (!disposed) changed();
      })
      .catch((err) => {
        if (!disposed) setError(String(err));
      });
    return () => {
      disposed = true;
      refreshRef.current = () => {};
      window.removeEventListener(INBOX_REFRESH_EVENT, changed);
      window.removeEventListener(INBOX_OPEN_EVENT, show);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", pause);
      for (const subscription of subscriptions)
        void subscription.then((release) => release()).catch(() => {});
      void setInboxStream(false).catch(() => {});
      setInboxUnreadCount(0);
    };
  }, []);
  const refresh = useCallback(() => refreshRef.current(), []);
  const reportIssue = () => {
    setOpen(false);
    openSettings("feedback");
  };
  const connectEarlierSurveys = async () => {
    if (!legacyInstallId || claiming || legacyClaimed) return;
    setClaiming(true);
    setError("");
    try {
      const count = await claimLegacySurveys(legacyInstallId);
      setLegacyClaimed(true);
      setClaimResult(count > 0
        ? `${count} earlier survey ${count === 1 ? "response" : "responses"} connected.`
        : "Earlier surveys are connected. Any team replies will appear here.");
      try {
        localStorage.setItem(LEGACY_CLAIMED_KEY, legacyInstallId);
      } catch {
        // Server-side claiming is idempotent if local storage is unavailable.
      }
      refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setClaiming(false);
    }
  };
  if (!feedbackInboxEnabled) return null;
  return (
    <>
      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title="Replies inbox"
        subtitle="Survey and feedback conversations"
        width="max-w-sm"
        placement="bottom-right"
        backdrop="subtle"
        headerClassName="p-4"
        titleClassName="text-sm"
        contentClassName="p-0 min-h-0"
      >
        <div className="space-y-3 p-4 text-app-text">
          <p className="text-xs text-app-muted">
            Replies are private to this installation.
          </p>
          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={refresh} className="text-xs text-app-accent hover:underline">
              Refresh inbox
            </button>
            <button
              type="button"
              onClick={reportIssue}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-app-border px-2.5 py-1.5 text-xs font-medium text-app-text transition-colors hover:bg-app-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/60"
            >
              <Bug size={13} aria-hidden="true" />
              Report issue
            </button>
          </div>
          {!legacyClaimed && legacyInstallId && (
            <div className="space-y-2 rounded-lg border border-app-border bg-app-surface/40 p-3 text-xs">
              <p className="font-medium text-app-text">Connect earlier surveys</p>
              <p className="text-app-muted">
                If you answered a survey in an older Zync version on this device,
                connect it to this inbox to receive team replies. This uses the
                existing installation ID rather than the newer private inbox
                credential. Only connect surveys on your own device.
              </p>
              <button
                disabled={claiming}
                onClick={() => void connectEarlierSurveys()}
                className="rounded-md bg-app-accent px-3 py-2 font-medium text-app-bg disabled:opacity-50"
              >
                {claiming ? "Connecting…" : "Connect earlier surveys"}
              </button>
            </div>
          )}
          {claimResult && <p role="status" className="text-xs text-app-muted">{claimResult}</p>}
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
          <InboxHistory
            snapshot={snapshot}
            revision={revision}
            onRefresh={refresh}
          />
        </div>
      </Modal>
    </>
  );
}
