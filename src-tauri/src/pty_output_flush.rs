//! PTY output flush policy: idle-immediate send, then a fixed burst epoch.
//!
//! Channel I/O stays in `pty.rs`. This module only decides *when* bytes should
//! leave and encodes the generation-prefixed frame. The 12 ms timer is a
//! **fixed epoch** from the idle-first send (or from a threshold re-arm). Later
//! packets in the same epoch do **not** reset it.
//!
//! `OUTPUT_BURST_FLUSH_THRESHOLD` is "flush at least this soon while bursting",
//! not a maximum frame size. An idle-first chunk may exceed the threshold.

use std::sync::atomic::{AtomicU64, Ordering};
use tokio::time::{Duration, Instant};

/// Fixed burst epoch after an idle-first send or a threshold re-arm.
pub const OUTPUT_BURST_EPOCH_MS: u64 = 12;
/// While bursting, flush pending at least this soon. Not a max frame size.
pub const OUTPUT_BURST_FLUSH_THRESHOLD: usize = 128 * 1024;

static FLUSH_IDLE_FIRST: AtomicU64 = AtomicU64::new(0);
static FLUSH_TIMER: AtomicU64 = AtomicU64::new(0);
static FLUSH_THRESHOLD: AtomicU64 = AtomicU64::new(0);
static FLUSH_CLOSE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushReason {
    IdleFirst,
    Timer,
    Threshold,
    Close,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushReasonCounts {
    pub idle_first: u64,
    pub timer: u64,
    pub threshold: u64,
    pub close: u64,
}

pub fn record_flush_reason(reason: FlushReason) {
    let counter = match reason {
        FlushReason::IdleFirst => &FLUSH_IDLE_FIRST,
        FlushReason::Timer => &FLUSH_TIMER,
        FlushReason::Threshold => &FLUSH_THRESHOLD,
        FlushReason::Close => &FLUSH_CLOSE,
    };
    counter.fetch_add(1, Ordering::Relaxed);
}

pub fn flush_reason_snapshot() -> FlushReasonCounts {
    FlushReasonCounts {
        idle_first: FLUSH_IDLE_FIRST.load(Ordering::Relaxed),
        timer: FLUSH_TIMER.load(Ordering::Relaxed),
        threshold: FLUSH_THRESHOLD.load(Ordering::Relaxed),
        close: FLUSH_CLOSE.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
pub fn reset_flush_reason_counts() {
    FLUSH_IDLE_FIRST.store(0, Ordering::Relaxed);
    FLUSH_TIMER.store(0, Ordering::Relaxed);
    FLUSH_THRESHOLD.store(0, Ordering::Relaxed);
    FLUSH_CLOSE.store(0, Ordering::Relaxed);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlushMode {
    Idle,
    Bursting,
}

pub struct OutputFlushPolicy {
    pending: Vec<u8>,
    mode: FlushMode,
    burst_deadline: Option<Instant>,
}

pub enum FlushInstruction {
    None,
    /// Caller must send `bytes` on the Channel before the next on_bytes/on_timer.
    Flush {
        bytes: Vec<u8>,
        /// True when the policy stayed Bursting (idle-first or threshold).
        /// Callers send `bytes` and ignore this; tests assert epoch re-arm.
        #[allow(dead_code)]
        rearm_burst: bool,
        reason: FlushReason,
    },
}

impl Default for OutputFlushPolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl OutputFlushPolicy {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
            mode: FlushMode::Idle,
            burst_deadline: None,
        }
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.burst_deadline
    }

    pub fn on_bytes(&mut self, chunk: &[u8], now: Instant) -> FlushInstruction {
        if chunk.is_empty() {
            return FlushInstruction::None;
        }

        match self.mode {
            FlushMode::Idle => {
                self.mode = FlushMode::Bursting;
                self.burst_deadline = Some(now + Duration::from_millis(OUTPUT_BURST_EPOCH_MS));
                FlushInstruction::Flush {
                    bytes: chunk.to_vec(),
                    rearm_burst: true,
                    reason: FlushReason::IdleFirst,
                }
            }
            FlushMode::Bursting => {
                self.pending.extend_from_slice(chunk);
                if self.pending.len() >= OUTPUT_BURST_FLUSH_THRESHOLD {
                    self.burst_deadline = Some(now + Duration::from_millis(OUTPUT_BURST_EPOCH_MS));
                    FlushInstruction::Flush {
                        bytes: std::mem::take(&mut self.pending),
                        rearm_burst: true,
                        reason: FlushReason::Threshold,
                    }
                } else {
                    FlushInstruction::None
                }
            }
        }
    }

    pub fn on_timer(&mut self, _now: Instant) -> FlushInstruction {
        if self.mode != FlushMode::Bursting || self.burst_deadline.is_none() {
            return FlushInstruction::None;
        }

        if self.pending.is_empty() {
            self.mode = FlushMode::Idle;
            self.burst_deadline = None;
            return FlushInstruction::None;
        }

        self.mode = FlushMode::Idle;
        self.burst_deadline = None;
        FlushInstruction::Flush {
            bytes: std::mem::take(&mut self.pending),
            rearm_burst: false,
            reason: FlushReason::Timer,
        }
    }

    /// EOF / exit / close / mpsc closed: drain, Idle, deadline None.
    pub fn take_tail_on_close(&mut self) -> Vec<u8> {
        self.mode = FlushMode::Idle;
        self.burst_deadline = None;
        std::mem::take(&mut self.pending)
    }
}

pub fn encode_output_frame(generation: u32, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&generation.to_le_bytes());
    frame.extend_from_slice(payload);
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    fn epoch() -> Duration {
        Duration::from_millis(OUTPUT_BURST_EPOCH_MS)
    }

    fn flush_bytes(instr: FlushInstruction) -> (Vec<u8>, bool, FlushReason) {
        match instr {
            FlushInstruction::Flush {
                bytes,
                rearm_burst,
                reason,
            } => (bytes, rearm_burst, reason),
            FlushInstruction::None => panic!("expected Flush"),
        }
    }

    #[test]
    fn idle_first_chunk_flushes_immediately() {
        let mut p = OutputFlushPolicy::new();
        let now = t0();
        let (bytes, rearm, reason) = flush_bytes(p.on_bytes(b"a", now));
        assert_eq!(bytes, b"a");
        assert!(rearm);
        assert_eq!(reason, FlushReason::IdleFirst);
        assert_eq!(p.deadline(), Some(now + epoch()));
    }

    #[test]
    fn burst_merge_then_timer_flushes_tail() {
        let mut p = OutputFlushPolicy::new();
        let now = t0();
        let _ = p.on_bytes(b"lead", now);
        assert!(matches!(p.on_bytes(b"one", now), FlushInstruction::None));
        assert!(matches!(p.on_bytes(b"two", now), FlushInstruction::None));
        let (bytes, rearm, reason) = flush_bytes(p.on_timer(now + epoch()));
        assert_eq!(bytes, b"onetwo");
        assert!(!rearm);
        assert_eq!(reason, FlushReason::Timer);
        assert!(p.deadline().is_none());
    }

    #[test]
    fn epoch_does_not_reset_on_append() {
        let mut p = OutputFlushPolicy::new();
        let now = t0();
        let _ = p.on_bytes(b"lead", now);
        let deadline = p.deadline().expect("epoch armed");
        assert!(matches!(
            p.on_bytes(b"x", now + Duration::from_millis(3)),
            FlushInstruction::None
        ));
        assert!(matches!(
            p.on_bytes(b"y", now + Duration::from_millis(6)),
            FlushInstruction::None
        ));
        assert_eq!(
            p.deadline(),
            Some(deadline),
            "append must not move the epoch"
        );
        let (bytes, rearm, _) = flush_bytes(p.on_timer(deadline));
        assert_eq!(bytes, b"xy");
        assert!(!rearm);
    }

    #[test]
    fn threshold_flush_stays_bursting_and_rearms_epoch() {
        let mut p = OutputFlushPolicy::new();
        let now = t0();
        let _ = p.on_bytes(b"lead", now);
        let first_deadline = p.deadline();
        let chunk = vec![b'z'; OUTPUT_BURST_FLUSH_THRESHOLD];
        let later = now + Duration::from_millis(1);
        let (bytes, rearm, reason) = flush_bytes(p.on_bytes(&chunk, later));
        assert!(bytes.len() >= OUTPUT_BURST_FLUSH_THRESHOLD);
        assert!(rearm);
        assert_eq!(reason, FlushReason::Threshold);
        let new_deadline = p.deadline().expect("re-armed");
        assert_eq!(new_deadline, later + epoch());
        assert_ne!(Some(new_deadline), first_deadline);
    }

    #[test]
    fn empty_epoch_returns_to_idle() {
        let mut p = OutputFlushPolicy::new();
        let now = t0();
        let _ = p.on_bytes(b"lead", now);
        assert!(matches!(p.on_timer(now + epoch()), FlushInstruction::None));
        assert!(p.deadline().is_none());
        let (bytes, rearm, reason) = flush_bytes(p.on_bytes(b"x", now + Duration::from_secs(1)));
        assert_eq!(bytes, b"x");
        assert!(rearm);
        assert_eq!(reason, FlushReason::IdleFirst);
    }

    #[test]
    fn take_tail_on_close_drains_pending() {
        let mut p = OutputFlushPolicy::new();
        let now = t0();
        let _ = p.on_bytes(b"lead", now);
        let _ = p.on_bytes(b"tail", now);
        let tail = p.take_tail_on_close();
        assert_eq!(tail, b"tail");
        assert!(p.deadline().is_none());
        assert!(p.take_tail_on_close().is_empty());
    }

    #[test]
    fn empty_on_bytes_is_none() {
        let mut p = OutputFlushPolicy::new();
        assert!(matches!(p.on_bytes(b"", t0()), FlushInstruction::None));
        assert!(p.deadline().is_none());
    }

    #[test]
    fn on_timer_in_idle_is_none() {
        let mut p = OutputFlushPolicy::new();
        assert!(matches!(p.on_timer(t0()), FlushInstruction::None));
    }

    #[test]
    fn encode_output_frame_is_u32_le_then_payload() {
        let frame = encode_output_frame(0x0102_0304, b"AB");
        assert_eq!(frame, [0x04, 0x03, 0x02, 0x01, b'A', b'B']);
        assert_eq!(frame.len(), 4 + 2);
    }

    #[test]
    fn idle_first_chunk_larger_than_threshold_is_one_frame() {
        let mut p = OutputFlushPolicy::new();
        let now = t0();
        let chunk = vec![b'q'; OUTPUT_BURST_FLUSH_THRESHOLD + 8];
        let (bytes, rearm, reason) = flush_bytes(p.on_bytes(&chunk, now));
        assert_eq!(bytes.len(), OUTPUT_BURST_FLUSH_THRESHOLD + 8);
        assert!(rearm);
        assert_eq!(reason, FlushReason::IdleFirst);
    }

    #[test]
    fn flush_reason_atomics_count_each_kind() {
        reset_flush_reason_counts();
        record_flush_reason(FlushReason::IdleFirst);
        record_flush_reason(FlushReason::Timer);
        record_flush_reason(FlushReason::Threshold);
        record_flush_reason(FlushReason::Close);
        record_flush_reason(FlushReason::Close);
        let snap = flush_reason_snapshot();
        assert_eq!(snap.idle_first, 1);
        assert_eq!(snap.timer, 1);
        assert_eq!(snap.threshold, 1);
        assert_eq!(snap.close, 2);
        reset_flush_reason_counts();
        assert_eq!(flush_reason_snapshot(), FlushReasonCounts::default());
    }
}
