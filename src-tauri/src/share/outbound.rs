use super::protocol::{encode_data_frame, MAX_MESSAGE_BYTES};
use base64::Engine;
use futures_util::{Sink, SinkExt};
use serde_json::Value;
use std::io::{self, Write};
use std::sync::Arc;
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio_tungstenite::tungstenite::Message;

pub(super) const DATA_CHUNK_BYTES: usize = 24 * 1024;
pub(super) const DATA_QUEUE_BYTES: usize = 4 * 1024 * 1024;
const DATA_QUEUE_MESSAGES: usize = 128;
const CONTROL_QUEUE_BYTES: usize = 64 * 1024;
pub(super) const CONTROL_QUEUE_MESSAGES: usize = 64;
const CONTROL_FRAME_BYTES: usize = 1024;

#[derive(Clone)]
pub(super) struct OutboundSender {
    tx: mpsc::Sender<QueuedFrame>,
    bytes: Arc<Semaphore>,
    max_frame: usize,
    binary_data: bool,
}

pub(super) struct QueuedFrame {
    message: Message,
    budget: OwnedSemaphorePermit,
}

impl QueuedFrame {
    /// Keep the encoded-byte reservation until the sink has flushed this frame.
    pub(super) async fn write_to<S: Sink<Message> + Unpin>(
        self,
        sink: &mut S,
    ) -> Result<(), S::Error> {
        let result = sink.send(self.message).await;
        drop(self.budget);
        result
    }
}

impl OutboundSender {
    /// Bound stream output by encoded bytes and message count, including in-flight I/O.
    pub(super) fn data_channel(binary_data: bool) -> (Self, mpsc::Receiver<QueuedFrame>) {
        Self::channel(
            binary_data,
            DATA_QUEUE_BYTES,
            DATA_QUEUE_MESSAGES,
            MAX_MESSAGE_BYTES,
        )
    }

    /// Reserve independent space for nonblocking overload replies.
    pub(super) fn control_channel() -> (Self, mpsc::Receiver<QueuedFrame>) {
        Self::channel(
            false,
            CONTROL_QUEUE_BYTES,
            CONTROL_QUEUE_MESSAGES,
            CONTROL_FRAME_BYTES,
        )
    }

    /// Construct a queue whose frame limit fits its semaphore's byte budget.
    fn channel(
        binary_data: bool,
        byte_budget: usize,
        messages: usize,
        max_frame: usize,
    ) -> (Self, mpsc::Receiver<QueuedFrame>) {
        assert!(max_frame <= byte_budget && byte_budget <= u32::MAX as usize);
        let (tx, rx) = mpsc::channel(messages);
        (
            Self {
                tx,
                bytes: Arc::new(Semaphore::new(byte_budget)),
                max_frame,
                binary_data,
            },
            rx,
        )
    }

    /// Await byte admission, but stop waiting immediately if the receiver closes.
    async fn reserve_bytes(&self, size: usize) -> Result<OwnedSemaphorePermit, String> {
        if size > self.max_frame {
            return Err("agent outbound frame too large".into());
        }
        tokio::select! {
            result = self.bytes.clone().acquire_many_owned(size as u32) => {
                result.map_err(|_| "agent write closed".to_string())
            }
            _ = self.tx.closed() => Err("agent write closed".into()),
        }
    }

    /// Count bounded JSON without allocating an encoded copy before admission.
    fn json_size(&self, value: &Value) -> Result<usize, String> {
        let mut counter = JsonSize {
            size: 0,
            limit: self.max_frame,
        };
        serde_json::to_writer(&mut counter, value).map_err(|e| e.to_string())?;
        Ok(counter.size)
    }

    /// Preserve per-stream ordering while awaiting byte and queue-slot admission.
    pub(super) async fn send_json(&self, value: Value) -> Result<(), String> {
        let budget = self.reserve_bytes(self.json_size(&value)?).await?;
        let slot = self
            .tx
            .reserve()
            .await
            .map_err(|_| "agent write closed".to_string())?;
        let text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
        slot.send(QueuedFrame {
            message: Message::Text(text.into()),
            budget,
        });
        Ok(())
    }

    /// Encode a single bounded chunk only after both byte and queue-slot admission.
    pub(super) async fn send_data(&self, stream_id: i64, chunk: &[u8]) -> Result<(), String> {
        if chunk.len() > DATA_CHUNK_BYTES {
            return Err("agent outbound data chunk too large".into());
        }
        let size = if self.binary_data {
            9 + chunk.len()
        } else {
            format!(r#"{{"type":"data","stream_id":{stream_id},"chunk":""}}"#).len()
                + chunk.len().div_ceil(3) * 4
        };
        let budget = self.reserve_bytes(size).await?;
        let slot = self
            .tx
            .reserve()
            .await
            .map_err(|_| "agent write closed".to_string())?;
        let message = if self.binary_data {
            Message::Binary(encode_data_frame(stream_id, chunk).into())
        } else {
            let encoded = base64::engine::general_purpose::STANDARD.encode(chunk);
            Message::Text(
                format!(r#"{{"type":"data","stream_id":{stream_id},"chunk":"{encoded}"}}"#).into(),
            )
        };
        slot.send(QueuedFrame { message, budget });
        Ok(())
    }

    /// Keep the relay reader nonblocking; a saturated control path ends the session.
    pub(super) fn try_json(&self, value: Value) -> Result<(), String> {
        let size = self.json_size(&value)?;
        let budget = self
            .bytes
            .clone()
            .try_acquire_many_owned(size as u32)
            .map_err(|_| "agent control byte budget exhausted".to_string())?;
        let slot = self
            .tx
            .try_reserve()
            .map_err(|_| "agent control queue full or closed".to_string())?;
        let text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
        slot.send(QueuedFrame {
            message: Message::Text(text.into()),
            budget,
        });
        Ok(())
    }
}

struct JsonSize {
    size: usize,
    limit: usize,
}

impl Write for JsonSize {
    /// Reject oversize serialized JSON without retaining any encoded bytes.
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.len() > self.limit - self.size {
            return Err(io::Error::other("agent outbound frame too large"));
        }
        self.size += buf.len();
        Ok(buf.len())
    }

    /// Counting JSON has no buffered output to flush.
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::share::protocol::decode_data_frame;
    use crate::share::proxy::FrameWriter;
    use serde_json::json;
    use std::time::Duration;
    use tokio::sync::oneshot;
    use tokio::time::timeout;

    const DEADLINE: Duration = Duration::from_secs(3);

    #[tokio::test]
    async fn byte_budget_counts_queued_and_in_flight_frames_before_resuming_producers() {
        let value = |n| json!({ "n": n, "payload": "a".repeat(40) });
        let size = serde_json::to_vec(&value(0)).unwrap().len();
        let (tx, mut rx) = OutboundSender::channel(false, size * 2, 8, size);
        tx.send_json(value(0)).await.unwrap();
        tx.send_json(value(1)).await.unwrap();
        let in_flight = rx.recv().await.unwrap();
        assert_eq!(tx.bytes.available_permits(), 0);
        let mut third = Box::pin(tx.send_json(value(2)));
        assert!(futures_util::poll!(&mut third).is_pending());
        assert_eq!(rx.len(), 1);
        drop(in_flight);
        timeout(DEADLINE, third).await.unwrap().unwrap();
        assert_eq!(tx.bytes.available_permits(), 0);
        for n in [1, 2] {
            let frame = rx.recv().await.unwrap();
            let decoded: Value = serde_json::from_str(frame.message.to_text().unwrap()).unwrap();
            assert_eq!(decoded["n"], n);
            drop(frame);
        }
        assert_eq!(tx.bytes.available_permits(), size * 2);
    }

    #[tokio::test]
    async fn byte_reservation_is_held_until_sink_flush_completes() {
        let (tx, mut rx) = OutboundSender::channel(true, 128, 4, 128);
        tx.send_data(7, b"abc").await.unwrap();
        let frame = rx.recv().await.unwrap();
        let charged = frame.message.len();
        let (release, waiting) = oneshot::channel::<()>();
        let mut sink = Box::pin(futures_util::sink::unfold(
            Some(waiting),
            |mut gate, _| async {
                gate.take().unwrap().await.unwrap();
                Ok::<_, ()>(gate)
            },
        ));
        let mut writing = Box::pin(frame.write_to(&mut sink));
        assert!(futures_util::poll!(&mut writing).is_pending());
        assert_eq!(tx.bytes.available_permits(), 128 - charged);
        release.send(()).unwrap();
        timeout(DEADLINE, writing).await.unwrap().unwrap();
        assert_eq!(tx.bytes.available_permits(), 128);
    }

    #[tokio::test]
    async fn cancelled_queue_slot_waiter_returns_its_byte_reservation() {
        let (tx, rx) = OutboundSender::channel(false, 512, 1, 256);
        let value = json!({ "n": 1 });
        let size = serde_json::to_vec(&value).unwrap().len();
        tx.send_json(value.clone()).await.unwrap();
        let mut blocked = Box::pin(tx.send_json(value));
        assert!(futures_util::poll!(&mut blocked).is_pending());
        assert_eq!(tx.bytes.available_permits(), 512 - size * 2);
        drop(blocked);
        assert_eq!(tx.bytes.available_permits(), 512 - size);
        drop(rx);
        assert_eq!(tx.bytes.available_permits(), 512);
    }

    #[tokio::test]
    async fn closed_receiver_wakes_byte_waiter_even_with_an_in_flight_frame() {
        let value = json!({ "n": 1 });
        let size = serde_json::to_vec(&value).unwrap().len();
        let (tx, mut rx) = OutboundSender::channel(false, size, 1, size);
        tx.send_json(value.clone()).await.unwrap();
        let in_flight = rx.recv().await.unwrap();
        let mut blocked = Box::pin(tx.send_json(value));
        assert!(futures_util::poll!(&mut blocked).is_pending());
        drop(rx);
        assert!(timeout(DEADLINE, blocked).await.unwrap().is_err());
        assert_eq!(tx.bytes.available_permits(), 0);
        drop(in_flight);
        assert_eq!(tx.bytes.available_permits(), size);
    }

    #[tokio::test]
    async fn oversize_frames_fail_without_consuming_budget_or_queue_slots() {
        let (tx, rx) = OutboundSender::channel(false, 256, 8, 64);
        let oversized = json!({ "payload": "x".repeat(200) });
        assert!(tx.send_json(oversized.clone()).await.is_err());
        assert!(tx.try_json(oversized).is_err());
        assert!(tx
            .send_data(1, &vec![0; DATA_CHUNK_BYTES + 1])
            .await
            .is_err());
        assert_eq!(tx.bytes.available_permits(), 256);
        assert_eq!(rx.len(), 0);
    }

    #[tokio::test]
    async fn text_and_binary_data_charge_exact_wire_lengths_and_preserve_bytes() {
        for binary in [false, true] {
            let (tx, mut rx) = OutboundSender::data_channel(binary);
            for id in [i64::MIN, 0, i64::MAX] {
                for size in [0, 1, 2, 3, DATA_CHUNK_BYTES] {
                    let bytes = vec![0x9f; size];
                    tx.send_data(id, &bytes).await.unwrap();
                    let frame = rx.recv().await.unwrap();
                    assert_eq!(
                        tx.bytes.available_permits(),
                        DATA_QUEUE_BYTES - frame.message.len()
                    );
                    if binary {
                        assert_eq!(
                            decode_data_frame(&frame.message.clone().into_data()),
                            Some((id, bytes.as_slice()))
                        );
                    } else {
                        let value: Value =
                            serde_json::from_str(frame.message.to_text().unwrap()).unwrap();
                        assert_eq!(value["type"], "data");
                        assert_eq!(value["stream_id"], id);
                        assert_eq!(
                            base64::engine::general_purpose::STANDARD
                                .decode(value["chunk"].as_str().unwrap())
                                .unwrap(),
                            bytes
                        );
                    }
                    drop(frame);
                    assert_eq!(tx.bytes.available_permits(), DATA_QUEUE_BYTES);
                }
            }
            let value = json!({ "text": "é\n\"☃" });
            tx.send_json(value.clone()).await.unwrap();
            let frame = rx.recv().await.unwrap();
            assert_eq!(
                tx.bytes.available_permits(),
                DATA_QUEUE_BYTES - frame.message.len()
            );
            assert_eq!(
                serde_json::from_str::<Value>(frame.message.to_text().unwrap()).unwrap(),
                value
            );
        }
    }

    #[tokio::test]
    async fn saturated_data_leaves_control_space_and_control_floods_stay_bounded() {
        let (data, data_rx) = OutboundSender::channel(true, 128, 1, 128);
        let (control, control_rx) = OutboundSender::control_channel();
        data.send_data(1, b"first").await.unwrap();
        let mut waiting = Box::pin(data.send_data(2, b"second"));
        assert!(futures_util::poll!(&mut waiting).is_pending());
        let reply = json!({ "type": "close", "stream_id": 1 });
        for _ in 0..CONTROL_QUEUE_MESSAGES {
            control.try_json(reply.clone()).unwrap();
        }
        assert!(control.try_json(reply).is_err());
        assert_eq!(control_rx.len(), CONTROL_QUEUE_MESSAGES);
        assert_eq!(data_rx.len(), 1);
        drop(waiting);
        drop(data_rx);
        drop(control_rx);
        assert_eq!(data.bytes.available_permits(), 128);
        assert_eq!(control.bytes.available_permits(), CONTROL_QUEUE_BYTES);
    }

    #[tokio::test]
    async fn frame_writer_preserves_headers_chunks_and_single_close_order() {
        for binary in [false, true] {
            let (tx, mut rx) = OutboundSender::data_channel(binary);
            let mut writer = FrameWriter::new(5, tx);
            writer.end(200, Default::default()).await.unwrap();
            writer
                .data(&vec![b'a'; DATA_CHUNK_BYTES * 2 + 1])
                .await
                .unwrap();
            writer.close().await.unwrap();
            writer.close().await.unwrap();
            assert_eq!(rx.len(), 5);
            let first = rx.recv().await.unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(first.message.to_text().unwrap()).unwrap()["type"],
                "end"
            );
            let mut received = Vec::new();
            for _ in 0..3 {
                let frame = rx.recv().await.unwrap();
                if binary {
                    let raw = frame.message.clone().into_data();
                    let (id, bytes) = decode_data_frame(&raw).unwrap();
                    assert_eq!(id, 5);
                    received.extend_from_slice(bytes);
                } else {
                    let value: Value =
                        serde_json::from_str(frame.message.to_text().unwrap()).unwrap();
                    received.extend_from_slice(
                        &base64::engine::general_purpose::STANDARD
                            .decode(value["chunk"].as_str().unwrap())
                            .unwrap(),
                    );
                }
            }
            assert_eq!(received, vec![b'a'; DATA_CHUNK_BYTES * 2 + 1]);
            let last = rx.recv().await.unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(last.message.to_text().unwrap()).unwrap()["type"],
                "close"
            );
        }
    }
}
