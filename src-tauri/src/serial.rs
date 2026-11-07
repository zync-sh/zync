//! Local serial sessions own device handles independently from shell PTYs.

use crate::{pty_output_flush::encode_output_frame, terminal_output::OutputWindow};
use serde::{Deserialize, Serialize};
use serialport::{
    DataBits, FlowControl, Parity, SerialPort, SerialPortInfo, SerialPortType, StopBits,
};
use std::{
    collections::HashMap,
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    State, WebviewWindow,
};
use tokio::sync::{oneshot, watch, Semaphore};
use uuid::Uuid;

const MAX_SESSIONS: usize = 4;
const INPUT_CHUNK: usize = 4 * 1024;
const INPUT_CHUNKS: usize = 16;
const OUTPUT_CHUNK: usize = 4 * 1024;
const OUTPUT_HEADER: usize = 8;
const OUTPUT_GENERATION: u32 = 1;
const OUTPUT_WINDOW_BYTES: usize = 128 * 1024;
const OUTPUT_WINDOW_FRAMES: usize = 128;
const IO_TIMEOUT: Duration = Duration::from_millis(25);
const STALL_TIMEOUT: Duration = Duration::from_secs(15);
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
static PORT_LIST_GATE: Semaphore = Semaphore::const_new(1);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SerialSettings {
    baud_rate: u32,
    data_bits: u8,
    parity: SerialParity,
    stop_bits: u8,
    flow_control: SerialFlowControl,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum SerialParity {
    None,
    Odd,
    Even,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum SerialFlowControl {
    None,
    Hardware,
    Software,
}

impl SerialSettings {
    /// Validate framing before touching the device, and leave supported baud rates to the driver.
    fn builder(self, port_id: &str) -> Result<serialport::SerialPortBuilder, String> {
        if self.baud_rate == 0 {
            return Err("Enter a positive serial baud rate.".into());
        }
        let data_bits = match self.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            8 => DataBits::Eight,
            _ => return Err("Serial data bits must be between 5 and 8.".into()),
        };
        let stop_bits = match self.stop_bits {
            1 => StopBits::One,
            2 => StopBits::Two,
            _ => return Err("Serial stop bits must be 1 or 2.".into()),
        };
        let parity = match self.parity {
            SerialParity::None => Parity::None,
            SerialParity::Odd => Parity::Odd,
            SerialParity::Even => Parity::Even,
        };
        let flow = match self.flow_control {
            SerialFlowControl::None => FlowControl::None,
            SerialFlowControl::Hardware => FlowControl::Hardware,
            SerialFlowControl::Software => FlowControl::Software,
        };
        Ok(serialport::new(port_id, self.baud_rate)
            .data_bits(data_bits)
            .stop_bits(stop_bits)
            .parity(parity)
            .flow_control(flow)
            .timeout(IO_TIMEOUT))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortChoice {
    id: String,
    label: String,
    document_id: String,
}

impl PortChoice {
    /// Report a port name and optional product label without exporting USB serial numbers.
    fn from_port(port: SerialPortInfo, document_id: Uuid) -> Self {
        let product = match port.port_type {
            SerialPortType::UsbPort(usb) => usb
                .product
                .map(|name| {
                    name.chars()
                        .filter(|character| !character.is_control())
                        .take(80)
                        .collect::<String>()
                })
                .filter(|name| !name.trim().is_empty()),
            _ => None,
        };
        let label = product.map_or_else(
            || port.port_name.clone(),
            |name| format!("{} — {}", port.port_name, name.trim()),
        );
        Self {
            id: port.port_name,
            label,
            document_id: document_id.to_string(),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum SerialStatus {
    Closed,
    Error { message: String },
}

/// Own a device reservation until the worker has dropped its handle.
struct SerialSession {
    port_id: String,
    cancelled: AtomicBool,
    ready: AtomicBool,
    done: watch::Sender<bool>,
    input: SyncSender<WriteRequest>,
    output: Mutex<OutputWindow>,
    output_changed: Condvar,
}

impl SerialSession {
    /// Allocate the input and output budgets while the device is still opening.
    fn new(port_id: String) -> (Self, Receiver<WriteRequest>) {
        let (input, receiver) = mpsc::sync_channel(INPUT_CHUNKS);
        (
            Self {
                port_id,
                cancelled: AtomicBool::new(false),
                ready: AtomicBool::new(false),
                done: watch::Sender::new(false),
                input,
                output: Mutex::new(OutputWindow::new(
                    OUTPUT_WINDOW_BYTES,
                    OUTPUT_WINDOW_FRAMES,
                    OUTPUT_HEADER,
                )),
                output_changed: Condvar::new(),
            },
            receiver,
        )
    }

    /// Stop admitting input and wake the worker without freeing its device claim early.
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.output_changed.notify_one();
    }

    /// Sample the stop request between timed device operations.
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    /// Admit a chunk and return its independent completion, without holding a registry lock.
    fn enqueue(&self, bytes: Vec<u8>) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        if bytes.is_empty() || bytes.len() > INPUT_CHUNK {
            return Err(format!(
                "Serial input must contain 1 to {INPUT_CHUNK} bytes."
            ));
        }
        if self.is_cancelled() || !self.ready.load(Ordering::Acquire) {
            return Err("Serial session is not connected.".into());
        }
        let (completed, result) = oneshot::channel();
        self.input
            .try_send(WriteRequest { bytes, completed })
            .map_err(|error| match error {
                TrySendError::Full(_) => "Serial input queue is full.",
                TrySendError::Disconnected(_) => "Serial session is not connected.",
            })?;
        Ok(result)
    }

    /// Give already-sent bytes a short chance to parse before reporting device loss.
    fn drain_output(&self) {
        let window = self.output.lock().unwrap();
        drop(
            self.output_changed
                .wait_timeout_while(window, OUTPUT_DRAIN_TIMEOUT, |window| {
                    !window.is_empty() && !self.is_cancelled()
                })
                .unwrap(),
        );
    }
}

struct SerialRegistry {
    document_id: Uuid,
    sessions: HashMap<Uuid, Arc<SerialSession>>,
}

impl Default for SerialRegistry {
    /// Start with a fresh renderer identity and no restored device ownership.
    fn default() -> Self {
        Self {
            document_id: Uuid::new_v4(),
            sessions: HashMap::new(),
        }
    }
}

/// Main-webview session admission, device claims, and document-generation invalidation.
#[derive(Clone, Default)]
pub(crate) struct SerialSessions(Arc<Mutex<SerialRegistry>>);

impl SerialSessions {
    /// Snapshot the renderer identity before starting a potentially blocking port scan.
    fn document_id(&self) -> Uuid {
        self.0.lock().unwrap().document_id
    }

    /// Atomically enforce the document, port, and session limits before spawning a worker.
    fn reserve(
        &self,
        id: Uuid,
        document_id: Uuid,
        port_id: String,
    ) -> Result<(WorkerLease, Receiver<WriteRequest>), String> {
        let mut registry = self.0.lock().unwrap();
        if registry.document_id != document_id {
            return Err("Refresh the serial port list before connecting.".into());
        }
        if registry.sessions.contains_key(&id) {
            return Err("Serial session is already open.".into());
        }
        if registry.sessions.len() >= MAX_SESSIONS {
            return Err("Close a serial console before opening another.".into());
        }
        if registry
            .sessions
            .values()
            .any(|session| session.port_id == port_id)
        {
            return Err("This serial port is already in use by Zync.".into());
        }
        let (session, input) = SerialSession::new(port_id);
        let session = Arc::new(session);
        registry.sessions.insert(id, Arc::clone(&session));
        Ok((
            WorkerLease {
                owner: self.clone(),
                id,
                session,
            },
            input,
        ))
    }

    /// Return a session handle without holding the registry lock during its operation.
    fn get(&self, id: Uuid) -> Option<Arc<SerialSession>> {
        self.0.lock().unwrap().sessions.get(&id).cloned()
    }

    /// Reject delayed open calls from the previous page and cancel live or opening ports.
    pub(crate) fn clear(&self) {
        let mut registry = self.0.lock().unwrap();
        registry.document_id = Uuid::new_v4();
        for session in registry.sessions.values() {
            session.cancel();
        }
    }
}

/// Free the claim and wake close callers after the worker drops its serial handle.
struct WorkerLease {
    owner: SerialSessions,
    id: Uuid,
    session: Arc<SerialSession>,
}

impl Drop for WorkerLease {
    /// Release the port claim before notifying callers waiting for Close to finish.
    fn drop(&mut self) {
        self.session.cancel();
        self.owner.0.lock().unwrap().sessions.remove(&self.id);
        self.session.done.send_replace(true);
    }
}

/// Restrict desktop device operations to the main workspace window.
fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Serial consoles are available only in the main window.".into());
    }
    Ok(())
}

/// Accept only the UUIDs used for renderer and session ownership.
fn parse_id(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|_| "Invalid serial identifier.".into())
}

/// Enumerate driver-provided port names without opening any of the devices.
fn enumerate() -> Result<Vec<SerialPortInfo>, String> {
    serialport::available_ports().map_err(|error| format!("Cannot list serial ports: {error}"))
}

/// Enumerate available serial devices without opening or claiming a port.
#[tauri::command]
pub(crate) async fn serial_list_ports(
    window: WebviewWindow,
    sessions: State<'_, SerialSessions>,
) -> Result<Vec<PortChoice>, String> {
    main_window(&window)?;
    let document_id = sessions.document_id();
    let permit = PORT_LIST_GATE
        .acquire()
        .await
        .map_err(|_| "The serial port list is unavailable.".to_string())?;
    if sessions.document_id() != document_id {
        return Err("Refresh the serial port list after reloading Zync.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let mut choices: Vec<_> = enumerate()?
            .into_iter()
            .map(|port| PortChoice::from_port(port, document_id))
            .collect();
        choices.sort_unstable_by(|left, right| left.id.cmp(&right.id));
        choices.dedup_by(|left, right| left.id == right.id);
        Ok(choices)
    })
    .await
    .map_err(|error| format!("Cannot list serial ports: {error}"))?
}

/// Open one enumerated port and stream framed output until close, unplug, or I/O failure.
#[tauri::command]
pub(crate) async fn serial_open(
    window: WebviewWindow,
    sessions: State<'_, SerialSessions>,
    session_id: String,
    document_id: String,
    port_id: String,
    settings: SerialSettings,
    output_channel: Channel<InvokeResponseBody>,
    status_channel: Channel<SerialStatus>,
) -> Result<(), String> {
    main_window(&window)?;
    let id = parse_id(&session_id)?;
    let document_id = parse_id(&document_id)?;
    let builder = settings.builder(&port_id)?;
    let (lease, input) = sessions.reserve(id, document_id, port_id)?;
    let (report_opened, opened) = oneshot::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let mut port = match open_port(&lease.session, builder) {
            Ok(port) => port,
            Err(error) => {
                drop(lease);
                let _ = report_opened.send(Err(error));
                return;
            }
        };
        lease.session.ready.store(true, Ordering::Release);
        if report_opened.send(Ok(())).is_err() {
            return;
        }
        let mut pending = None;
        let result = pump(&mut *port, &lease.session, &input, &mut pending, |frame| {
            output_channel
                .send(InvokeResponseBody::Raw(frame))
                .map_err(|_| "Serial output could not reach the terminal.".into())
        });
        drop(port);
        if result.is_err() {
            lease.session.drain_output();
        }
        let status = match result {
            Err(message) if !lease.session.is_cancelled() => SerialStatus::Error { message },
            _ => SerialStatus::Closed,
        };
        drop(lease);
        // A rejected write closes the renderer's channels. Let its final output parse first.
        if let (SerialStatus::Error { message }, Some(write)) = (&status, pending) {
            let _ = write.request.completed.send(Err(message.clone()));
        }
        let _ = status_channel.send(status);
    });
    opened
        .await
        .map_err(|_| "Serial worker stopped opening the port.".to_string())?
}

/// Revalidate the selected device and close a handle opened after cancellation.
fn open_port(
    session: &SerialSession,
    builder: serialport::SerialPortBuilder,
) -> Result<Box<dyn SerialPort>, String> {
    if session.is_cancelled() {
        return Err("Serial connection was cancelled.".into());
    }
    if !enumerate()?
        .iter()
        .any(|port| port.port_name == session.port_id)
    {
        return Err("The selected serial port is no longer available.".into());
    }
    if session.is_cancelled() {
        return Err("Serial connection was cancelled.".into());
    }
    let port = builder
        .open()
        .map_err(|error| format!("Cannot open {}: {error}", session.port_id))?;
    if session.is_cancelled() {
        return Err("Serial connection was cancelled.".into());
    }
    Ok(port)
}

/// Deliver a bounded chunk to the device driver before granting the renderer more input credit.
#[tauri::command]
pub(crate) async fn serial_write(
    window: WebviewWindow,
    sessions: State<'_, SerialSessions>,
    session_id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    main_window(&window)?;
    let completion = sessions
        .get(parse_id(&session_id)?)
        .ok_or("Serial session is not connected.")?
        .enqueue(bytes)?;
    completion
        .await
        .map_err(|_| "Serial session closed before writing the input.".to_string())?
}

/// Release output credit after xterm has parsed the corresponding frames.
#[tauri::command]
pub(crate) fn serial_ack_output(
    window: WebviewWindow,
    sessions: State<'_, SerialSessions>,
    session_id: String,
    sequence: u32,
) -> Result<(), String> {
    main_window(&window)?;
    if let Some(session) = sessions.get(parse_id(&session_id)?) {
        session.output.lock().unwrap().acknowledge(sequence)?;
        session.output_changed.notify_one();
    }
    Ok(())
}

/// Close a live or opening session, waiting briefly for its worker to release the handle.
#[tauri::command]
pub(crate) async fn serial_close(
    window: WebviewWindow,
    sessions: State<'_, SerialSessions>,
    session_id: String,
) -> Result<(), String> {
    main_window(&window)?;
    if let Some(session) = sessions.get(parse_id(&session_id)?) {
        session.cancel();
        let mut done = session.done.subscribe();
        tokio::time::timeout(CLOSE_TIMEOUT, done.wait_for(|finished| *finished))
            .await
            .map_err(|_| "The serial port is still closing.".to_string())?
            .map_err(|_| "Serial close notification was lost.".to_string())?;
    }
    Ok(())
}

/// Service bounded input and output, leaving any incomplete write with the caller during teardown.
fn pump(
    port: &mut (impl Read + Write + ?Sized),
    session: &SerialSession,
    input: &Receiver<WriteRequest>,
    pending: &mut Option<PendingWrite>,
    mut send_frame: impl FnMut(Vec<u8>) -> Result<(), String>,
) -> Result<(), String> {
    let mut read_buffer = [0; OUTPUT_CHUNK];
    while !session.is_cancelled() {
        if pending.is_none() {
            *pending = input.try_recv().ok().map(PendingWrite::new);
        }
        if let Some(mut write) = pending.take() {
            match write.advance(port) {
                Ok(false) => *pending = Some(write),
                Ok(true) => {
                    let _ = write.request.completed.send(Ok(()));
                }
                Err(error) => {
                    *pending = Some(write);
                    return Err(error);
                }
            }
        }

        {
            let window = session.output.lock().unwrap();
            if window.stalled(Instant::now(), STALL_TIMEOUT) {
                return Err("Serial output stalled while waiting for the terminal.".into());
            }
            if !window.can_send(OUTPUT_CHUNK) {
                drop(
                    session
                        .output_changed
                        .wait_timeout(window, IO_TIMEOUT)
                        .unwrap(),
                );
                continue;
            }
        }
        match port.read(&mut read_buffer) {
            Ok(0) => return Err("The serial device disconnected.".into()),
            Ok(count) if !session.is_cancelled() => {
                let sequence = session
                    .output
                    .lock()
                    .unwrap()
                    .reserve(count, Instant::now())?;
                send_frame(encode_output_frame(
                    OUTPUT_GENERATION,
                    sequence,
                    &read_buffer[..count],
                ))?;
            }
            Ok(_) => break,
            Err(error) if can_retry(&error) => {}
            Err(error) => return Err(format!("Serial read failed: {error}")),
        }
    }
    Ok(())
}

struct WriteRequest {
    bytes: Vec<u8>,
    completed: oneshot::Sender<Result<(), String>>,
}

struct PendingWrite {
    request: WriteRequest,
    offset: usize,
    last_progress: Instant,
}

impl PendingWrite {
    /// Start the stall timer when a chunk reaches the driver, excluding time in the queue.
    fn new(request: WriteRequest) -> Self {
        Self {
            request,
            offset: 0,
            last_progress: Instant::now(),
        }
    }

    /// Retain partial writes across timed I/O and stop if the device cannot make progress.
    fn advance(&mut self, port: &mut (impl Write + ?Sized)) -> Result<bool, String> {
        match port.write(&self.request.bytes[self.offset..]) {
            Ok(count) if count != 0 => {
                self.offset += count;
                self.last_progress = Instant::now();
            }
            Ok(_) => {}
            Err(error) if can_retry(&error) => {}
            Err(error) => return Err(format!("Serial write failed: {error}")),
        }
        if self.last_progress.elapsed() >= STALL_TIMEOUT {
            return Err("The serial device stopped accepting input.".into());
        }
        Ok(self.offset == self.request.bytes.len())
    }
}

/// Distinguish transient no-progress operations from device failures.
fn can_retry(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[test]
    fn validates_serial_framing_before_opening() {
        let deserialize = |baud_rate, data_bits, stop_bits| {
            serde_json::from_value::<SerialSettings>(serde_json::json!({
                "baudRate": baud_rate,
                "dataBits": data_bits,
                "parity": "even",
                "stopBits": stop_bits,
                "flowControl": "hardware",
            }))
            .unwrap()
        };
        assert!(deserialize(115_200, 8, 1).builder("COM1").is_ok());
        assert!(deserialize(0, 8, 1).builder("COM1").is_err());
        assert!(deserialize(115_200, 4, 1).builder("COM1").is_err());
        assert!(deserialize(115_200, 8, 3).builder("COM1").is_err());
    }

    #[test]
    fn reload_cancels_workers_and_old_documents_cannot_reclaim_a_device() {
        let sessions = SerialSessions::default();
        let old_document = sessions.document_id();
        let id = Uuid::new_v4();
        let (lease, _) = sessions.reserve(id, old_document, "COM1".into()).unwrap();
        let done = lease.session.done.subscribe();
        assert!(sessions.reserve(id, old_document, "COM2".into()).is_err());
        assert!(sessions
            .reserve(Uuid::new_v4(), old_document, "COM1".into())
            .is_err());

        sessions.clear();
        assert!(lease.session.is_cancelled());
        assert!(!*done.borrow());
        let new_document = sessions.document_id();
        assert_ne!(new_document, old_document);
        assert!(sessions
            .reserve(Uuid::new_v4(), old_document, "COM2".into())
            .is_err());
        assert!(sessions
            .reserve(Uuid::new_v4(), new_document, "COM1".into())
            .is_err());

        drop(lease);
        assert!(*done.borrow());
        assert!(sessions.get(id).is_none());
        assert!(sessions
            .reserve(Uuid::new_v4(), new_document, "COM1".into())
            .is_ok());
    }

    #[test]
    fn limits_opening_and_live_sessions_together() {
        let sessions = SerialSessions::default();
        let document = sessions.document_id();
        let leases: Vec<_> = (0..MAX_SESSIONS)
            .map(|index| {
                sessions
                    .reserve(Uuid::new_v4(), document, format!("COM{index}"))
                    .unwrap()
            })
            .collect();
        assert!(sessions
            .reserve(Uuid::new_v4(), document, "COM99".into())
            .is_err());
        drop(leases);
        assert!(sessions
            .reserve(Uuid::new_v4(), document, "COM99".into())
            .is_ok());
    }

    #[test]
    fn bounds_input_and_refuses_unready_or_cancelled_sessions() {
        let (session, input) = SerialSession::new("COM1".into());
        assert!(session.enqueue(vec![1]).is_err());
        session.ready.store(true, Ordering::Release);
        assert!(session.enqueue(vec![]).is_err());
        assert!(session.enqueue(vec![0; INPUT_CHUNK + 1]).is_err());
        for index in 0..INPUT_CHUNKS {
            let _completion = session.enqueue(vec![index as u8; INPUT_CHUNK]).unwrap();
        }
        assert_eq!(
            session.enqueue(vec![1]).unwrap_err(),
            "Serial input queue is full."
        );
        assert_eq!(input.try_recv().unwrap().bytes, vec![0; INPUT_CHUNK]);
        let _completion = session.enqueue(vec![1]).unwrap();
        session.cancel();
        assert!(session.enqueue(vec![1]).is_err());
    }

    #[derive(Default)]
    struct FakePort {
        reads: VecDeque<Vec<u8>>,
        writes: Vec<u8>,
        fail_write_after: Option<usize>,
    }

    impl Read for FakePort {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let Some(bytes) = self.reads.pop_front() else {
                return Ok(0);
            };
            buffer[..bytes.len()].copy_from_slice(&bytes);
            Ok(bytes.len())
        }
    }

    impl Write for FakePort {
        fn write(&mut self, data: &[u8]) -> io::Result<usize> {
            if self
                .fail_write_after
                .is_some_and(|limit| self.writes.len() >= limit)
            {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "Device disappeared",
                ));
            }
            let count = data.len().min(2);
            self.writes.extend_from_slice(&data[..count]);
            Ok(count)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn frames_raw_device_bytes_and_retries_partial_writes_in_fifo_order() {
        let (session, input) = SerialSession::new("COM1".into());
        session.ready.store(true, Ordering::Release);
        let mut first = session.enqueue(vec![0, 255, 13, 10]).unwrap();
        let mut second = session.enqueue(vec![3]).unwrap();
        let mut port = FakePort {
            reads: VecDeque::from([vec![0xff], vec![0x00], vec![0x80]]),
            ..Default::default()
        };
        let mut frames = Vec::new();
        pump(&mut port, &session, &input, &mut None, |frame| {
            let sequence = u32::from_le_bytes(frame[4..8].try_into().unwrap());
            if sequence == 1 {
                assert_eq!(first.try_recv(), Err(oneshot::error::TryRecvError::Empty));
            }
            session.output.lock().unwrap().acknowledge(sequence)?;
            frames.push(frame);
            if frames.len() == 3 {
                session.cancel();
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(port.writes, [0, 255, 13, 10, 3]);
        assert_eq!(first.try_recv(), Ok(Ok(())));
        assert_eq!(second.try_recv(), Ok(Ok(())));
        assert_eq!(frames[0], [1, 0, 0, 0, 1, 0, 0, 0, 0xff]);
        assert_eq!(frames[1], [1, 0, 0, 0, 2, 0, 0, 0, 0x00]);
        assert_eq!(frames[2], [1, 0, 0, 0, 3, 0, 0, 0, 0x80]);
        assert!(session.output.lock().unwrap().is_empty());
    }

    #[test]
    fn cancels_the_completion_of_an_interrupted_write() {
        let (session, input) = SerialSession::new("COM1".into());
        session.ready.store(true, Ordering::Release);
        let mut completion = session.enqueue(vec![1, 2, 3, 4]).unwrap();
        let mut port = FakePort {
            reads: VecDeque::from([vec![0x01]]),
            ..Default::default()
        };
        pump(&mut port, &session, &input, &mut None, |_| {
            session.cancel();
            Ok(())
        })
        .unwrap();
        assert_eq!(port.writes, [1, 2]);
        assert_eq!(
            completion.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        );
    }

    #[test]
    fn disconnects_if_output_parser_has_stalled_or_port_reaches_end_of_stream() {
        let (session, input) = SerialSession::new("COM1".into());
        let mut port = FakePort::default();
        assert!(pump(&mut port, &session, &input, &mut None, |_| Ok(()))
            .unwrap_err()
            .contains("disconnected"));
        session
            .output
            .lock()
            .unwrap()
            .reserve(1, Instant::now() - STALL_TIMEOUT)
            .unwrap();
        assert!(pump(&mut port, &session, &input, &mut None, |_| Ok(()))
            .unwrap_err()
            .contains("stalled"));
    }

    #[test]
    fn device_failure_leaves_incomplete_write_pending_for_final_output_drain() {
        for fail_write_after in [None, Some(2)] {
            let (session, input) = SerialSession::new("COM1".into());
            session.ready.store(true, Ordering::Release);
            let mut completion = session.enqueue(vec![1, 2, 3, 4, 5, 6]).unwrap();
            let mut port = FakePort {
                reads: VecDeque::from([vec![0x80]]),
                fail_write_after,
                ..Default::default()
            };
            let mut pending = None;
            let error = pump(&mut port, &session, &input, &mut pending, |_| Ok(())).unwrap_err();
            assert!(error.contains(if fail_write_after.is_some() {
                "Serial write failed"
            } else {
                "disconnected"
            }));
            assert!(!session.output.lock().unwrap().is_empty());
            assert_eq!(
                completion.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            );
            assert!(pending.is_some());
        }
    }
}
