//! Native SSH actor. A separate bounded writer keeps remote input backpressure
//! from blocking output reads. All tasks are joined/aborted before quota release.
use super::{
    policy::{self, Launch, OutputBatch, OutputWindow, Size},
    registry::{Controls, Owner, PluginTerminals},
    validate,
};
use crate::commands::AppState;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle,
};
use tokio::{
    io::AsyncWriteExt,
    sync::{mpsc, oneshot, watch},
};

type RemoteChannel = russh::Channel<russh::client::Msg>;
const OPEN_TIMEOUT: Duration = Duration::from_secs(5);

/// Always releases reservations on task errors or panics, not just happy paths.
struct Reservation {
    registry: PluginTerminals,
    id: String,
    done: watch::Sender<bool>,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let _ = self.registry.with(|registry| {
            registry.finish(&self.id);
            Ok(())
        });
        self.done.send_replace(true);
    }
}

/// A channel already delivered into a oneshot can also be abandoned before its
/// receiver polls it. Drop must close that channel, not just drop its handle.
struct OwnedChannel {
    channel: Option<RemoteChannel>,
    reservation: Arc<Reservation>,
}

impl OwnedChannel {
    async fn close(mut self) {
        if let Some(channel) = &self.channel {
            let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
        }
        self.channel = None;
    }
}

impl Drop for OwnedChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.channel.take() {
            let reservation = self.reservation.clone();
            tokio::spawn(async move {
                let _reservation = reservation;
                let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
            });
        }
    }
}

/// An ordinary channel-open request can outlive its waiting future.
/// Retain it independently of UI cancellation and close any late-created channel.
/// Its reservation is retained until that cleanup, never freed by a UI timeout.
fn open_channel<H: russh::client::Handler + 'static>(
    session: Arc<tokio::sync::Mutex<Arc<russh::client::Handle<H>>>>,
    reservation: Arc<Reservation>,
) -> oneshot::Receiver<Result<OwnedChannel, String>> {
    let (sender, receiver) = oneshot::channel();
    tokio::spawn(async move {
        let result = session
            .lock()
            .await
            .channel_open_session()
            .await
            .map(|channel| OwnedChannel {
                channel: Some(channel),
                reservation: reservation.clone(),
            })
            .map_err(|error| error.to_string());
        let _ = sender.send(result); // An abandoned OwnedChannel closes on drop.
    });
    receiver
}

#[cfg(test)]
#[path = "ssh_tests.rs"]
mod ssh_tests;

async fn canceled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

/// Wait for server acceptance, bounded even when a server never answers. Early
/// PTY data is retained and forwarded after startup, never silently discarded.
async fn accepted(channel: &mut RemoteChannel, early: &mut Vec<u8>) -> Result<(), String> {
    tokio::time::timeout(OPEN_TIMEOUT, async {
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Success) => return Ok(()),
                Some(russh::ChannelMsg::Failure | russh::ChannelMsg::Close) | None => {
                    return Err("Server rejected the interactive terminal".into())
                }
                Some(
                    russh::ChannelMsg::Data { data } | russh::ChannelMsg::ExtendedData { data, .. },
                ) => {
                    if early.len().saturating_add(data.len()) > policy::OUTPUT_BYTES / 2 {
                        return Err("Excessive output during terminal startup".into());
                    }
                    early.extend_from_slice(&data);
                }
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| "Server did not accept the terminal in time".to_string())?
}

fn emit_output(output: &Channel<InvokeResponseBody>, frame: Vec<u8>) -> Result<(), String> {
    output
        .send(InvokeResponseBody::Raw(frame))
        .map_err(|_| "Terminal renderer disconnected".to_string())
}

fn monitor(
    app: AppHandle,
    state: AppState,
    owner: Arc<Owner>,
    cancel: watch::Sender<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut checks = tokio::time::interval(Duration::from_millis(250));
        let mut next_grant_check = Instant::now();
        loop {
            checks.tick().await;
            if !owner.connected(&state).await {
                cancel.send_replace(true);
                break;
            }
            if Instant::now() >= next_grant_check {
                if validate(&app, &state, &owner, false).await.is_err() {
                    cancel.send_replace(true);
                    break;
                }
                next_grant_check = Instant::now() + Duration::from_secs(1);
            }
        }
    })
}

/// Owned task resources make channel direction and lifecycle ownership explicit.
pub struct TerminalTask {
    pub id: String,
    pub owner: Arc<Owner>,
    pub launch: Launch,
    pub size: Size,
    pub controls: Controls,
    pub input: mpsc::Receiver<Vec<u8>>,
    pub sizes: watch::Receiver<Size>,
    pub acknowledgements: mpsc::Receiver<u32>,
    pub cancel: watch::Receiver<bool>,
    pub done: watch::Sender<bool>,
    pub output: Channel<InvokeResponseBody>,
    pub events: Channel<serde_json::Value>,
    pub started: oneshot::Sender<Result<(), String>>,
}

/// Starts immediately so cancellation cannot abandon a consumed approval. The
/// caller gets success only after both PTY and exec are accepted by the server.
pub fn spawn(app: AppHandle, state: AppState, registry: PluginTerminals, task: TerminalTask) {
    let TerminalTask {
        id,
        owner,
        launch,
        size,
        controls,
        input,
        mut sizes,
        mut acknowledgements,
        mut cancel,
        done,
        output,
        events,
        started,
    } = task;
    tauri::async_runtime::spawn(async move {
        let reservation = Arc::new(Reservation {
            registry: registry.clone(),
            id: id.clone(),
            done,
        });
        let mut started = Some(started);
        let mut channel = None;
        let mut writer_task = None;
        let mut monitor_task = None;
        let operation = async {
            validate(&app, &state, &owner, false).await?;
            monitor_task = Some(monitor(
                app.clone(),
                state.clone(),
                owner.clone(),
                controls.cancel.clone(),
            ));
            let session = owner
                .session
                .upgrade()
                .ok_or("The server is disconnected")?;
            let remote =
                tokio::time::timeout(OPEN_TIMEOUT, open_channel(session, reservation.clone()))
                    .await
                    .map_err(|_| "Timed out opening interactive SSH channel".to_string())?
                    .map_err(|_| "Interactive SSH opening task ended unexpectedly".to_string())??;
            channel = Some(remote);
            let remote = channel.as_mut().unwrap().channel.as_mut().unwrap();
            let mut early = Vec::new();
            tokio::time::timeout(
                OPEN_TIMEOUT,
                remote.request_pty(true, "xterm-256color", size.cols, size.rows, 0, 0, &[]),
            )
            .await
            .map_err(|_| "Timed out requesting terminal PTY")?
            .map_err(|error| error.to_string())?;
            accepted(remote, &mut early).await?;
            // Connection, package and grants may have changed during server setup.
            validate(&app, &state, &owner, false).await?;
            tokio::time::timeout(OPEN_TIMEOUT, remote.exec(true, launch.command_line()?))
                .await
                .map_err(|_| "Timed out requesting terminal command")?
                .map_err(|error| error.to_string())?;
            accepted(remote, &mut early).await?;
            // Do not pause SSH output for disk scans after exec; the independent
            // monitor revalidates grants while this actor drains the receive queue.
            if !owner.connected(&state).await {
                return Err("Terminal connection changed during startup".into());
            }
            registry.with(|registry| registry.running(&id))?;

            let writer = remote.make_writer();
            let writer_cancel = controls.cancel.clone();
            let writer_owner = owner.clone();
            let writer_state = state.clone();
            writer_task = Some(tokio::spawn(async move {
                tokio::pin!(writer);
                let mut input = input;
                while let Some(bytes) = input.recv().await {
                    if !writer_owner.connected(&writer_state).await {
                        writer_cancel.send_replace(true);
                        break;
                    }
                    if tokio::time::timeout(OPEN_TIMEOUT, writer.as_mut().write_all(&bytes))
                        .await
                        .map_or(true, |result| result.is_err())
                    {
                        writer_cancel.send_replace(true);
                        break;
                    }
                }
            }));

            if started.take().unwrap().send(Ok(())).is_err() {
                return Err("Terminal opening was abandoned".into());
            }
            let mut window = OutputWindow::default();
            let mut batch = OutputBatch::default();
            batch.push(&early, &mut window, |frame| emit_output(&output, frame))?;
            let mut timer = tokio::time::interval(policy::OUTPUT_FLUSH);
            loop {
                if !owner.live() {
                    return Err("Terminal owner changed".into());
                }
                tokio::select! {
                    message = remote.wait() => match message {
                        Some(russh::ChannelMsg::Data { data } | russh::ChannelMsg::ExtendedData { data, .. }) => batch.push(&data, &mut window, |frame| emit_output(&output, frame))?,
                        Some(russh::ChannelMsg::ExitStatus { exit_status }) => { let _ = events.send(serde_json::json!({"type":"exit","exitCode":exit_status})); },
                        Some(russh::ChannelMsg::ExitSignal { .. }) => return Err("Server terminal terminated by a signal".into()),
                        Some(russh::ChannelMsg::Close) | None => {
                            batch.flush(&mut window, |frame| emit_output(&output, frame))?;
                            // A raw Tauri frame is fetched asynchronously. Do not
                            // detach the host renderer before its final writes.
                            tokio::time::timeout(policy::ACK_TIMEOUT, async {
                                while !window.is_empty() {
                                    window.acknowledge(acknowledgements.recv().await.ok_or("Terminal acknowledgements closed")?)?;
                                }
                                Ok::<(), String>(())
                            }).await.map_err(|_| "Terminal final output was not acknowledged")??;
                            return Ok(());
                        },
                        _ => {} // EOF may precede exit status and close.
                    },
                    ack = acknowledgements.recv() => window.acknowledge(ack.ok_or("Terminal acknowledgement channel closed")?)?,
                    changed = sizes.changed() => {
                        changed.map_err(|_| "Terminal resize channel closed")?;
                        let size = *sizes.borrow_and_update();
                        // Resize is advisory: a slow/rejected update must not
                        // close a live shell. The watch channel retains later sizes.
                        let _ = tokio::time::timeout(Duration::from_millis(100), remote.window_change(size.cols, size.rows, 0, 0)).await;
                    },
                    _ = timer.tick() => {
                        batch.flush(&mut window, |frame| emit_output(&output, frame))?;
                        if window.stalled(Instant::now()) { return Err("Terminal renderer stopped acknowledging output".into()); }
                    }
                }
            }
        };
        let result: Result<(), String> = tokio::select! {
            result = operation => result,
            _ = canceled(&mut cancel) => Err("Terminal was closed or its authority changed".into()),
        };
        if let Some(started) = started {
            let _ = started.send(result.clone());
        }
        if let Some(task) = writer_task {
            task.abort();
            let _ = task.await;
        }
        if let Some(task) = monitor_task {
            task.abort();
            let _ = task.await;
        }
        // Dropping our channel after a bounded close does not guarantee killing a
        // detached remote process. Never claim transactional command cancellation.
        if let Some(remote) = channel {
            remote.close().await;
        }
        let _ = events.send(serde_json::json!({"type":"closed","reason":result.err()}));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_is_sticky_and_sender_loss_also_cancels() {
        let (sender, mut receiver) = watch::channel(false);
        sender.send_replace(true);
        tokio::time::timeout(Duration::from_millis(100), canceled(&mut receiver))
            .await
            .unwrap();
        let (sender, mut receiver) = watch::channel(false);
        drop(sender);
        tokio::time::timeout(Duration::from_millis(100), canceled(&mut receiver))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn queued_input_and_resize_have_fixed_capacity() {
        let (sender, mut receiver) = mpsc::channel(policy::INPUT_PACKETS);
        for _ in 0..policy::INPUT_PACKETS {
            sender.try_send(vec![0; policy::INPUT_BYTES]).unwrap();
        }
        assert!(sender.try_send(vec![0; policy::INPUT_BYTES]).is_err());
        receiver.recv().await.unwrap();
        assert!(sender.try_send(vec![0; policy::INPUT_BYTES]).is_ok());
        let (sender, receiver) = watch::channel(Size { cols: 80, rows: 24 });
        for cols in 1..=1000 {
            sender.send_replace(Size { cols, rows: 24 });
        }
        assert_eq!(receiver.borrow().cols, 1000);
    }

    #[test]
    fn cleanup_guard_notifies_waiting_close_even_on_early_task_failure() {
        let registry = PluginTerminals::default();
        let (done, receiver) = watch::channel(false);
        let reservation = Reservation {
            registry,
            id: "unused".into(),
            done,
        };
        assert!(!*receiver.borrow());
        drop(reservation);
        assert!(*receiver.borrow());
    }

    #[tokio::test]
    async fn abandoned_handoff_keeps_capacity_until_its_owner_is_dropped() {
        let (done, receiver) = watch::channel(false);
        let reservation = Arc::new(Reservation {
            registry: PluginTerminals::default(),
            id: "unused".into(),
            done,
        });
        let (sender, handoff) = oneshot::channel();
        sender
            .send(OwnedChannel {
                channel: None,
                reservation: reservation.clone(),
            })
            .ok()
            .unwrap();
        drop(reservation);
        assert!(!*receiver.borrow());
        drop(handoff);
        assert!(*receiver.borrow());
    }
}
