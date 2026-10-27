//! Noninteractive commands own their channel, never a connection-registry lock.
use std::sync::Arc;
use std::time::Duration;

use russh::{client, Channel, ChannelMsg};
use tokio::io::AsyncWriteExt;
use tokio::sync::{oneshot, Mutex};

const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);

/// Default caller deadline for noninteractive commands; callers may override it.
pub(crate) const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) type SshSession = Arc<Mutex<client::Handle<crate::ssh::Client>>>;

struct OwnedChannel(Option<Channel<client::Msg>>);

impl OwnedChannel {
    async fn close(mut self) {
        if let Some(channel) = &self.0 {
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, channel.close()).await;
        }
        self.0 = None;
    }
}

impl Drop for OwnedChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.0.take() {
            tokio::spawn(async move {
                let _ = tokio::time::timeout(CLOSE_TIMEOUT, channel.close()).await;
            });
        }
    }
}

/// Channel confirmation may arrive after the caller times out or is cancelled.
/// Keep ownership until then so a late channel is closed instead of abandoned.
fn open_channel<H: client::Handler + 'static>(
    session: Arc<Mutex<client::Handle<H>>>,
) -> oneshot::Receiver<Result<OwnedChannel, String>> {
    let (mut sender, receiver) = oneshot::channel();
    tokio::spawn(async move {
        let handle = tokio::select! {
            _ = sender.closed() => return,
            handle = session.lock() => handle,
        };
        if sender.is_closed() {
            return;
        }
        let result = handle
            .channel_open_session()
            .await
            .map(|channel| OwnedChannel(Some(channel)))
            .map_err(|error| format!("SSH channel error: {error}"));
        drop(handle);
        // A failed send drops OwnedChannel and closes the late-created channel.
        let _ = sender.send(result);
    });
    receiver
}

/// The session mutex is held only while opening the channel. Execution, stdin
/// and output operate on that owned channel and cannot block other session users.
/// Output callbacks receive stream 0 for stdout and 1 for stderr. A missing exit
/// status is returned as None so callers can apply their own success policy.
/// Stdin and output progress together so early remote failures remain observable.
pub(crate) async fn run<H: client::Handler + 'static>(
    session: Arc<Mutex<client::Handle<H>>>,
    command: &str,
    input: Option<&[u8]>,
    timeout: Duration,
    mut on_data: impl FnMut(u32, &[u8]),
) -> Result<Option<u32>, String> {
    tokio::time::timeout(timeout, async {
        let mut owned = open_channel(session)
            .await
            .map_err(|_| "SSH channel opening task ended".to_string())??;
        let channel = owned.0.as_mut().expect("owned command channel");
        channel
            .exec(true, command)
            .await
            .map_err(|error| format!("SSH exec error: {error}"))?;
        let mut writer = channel.make_writer();
        let send_input = async {
            if let Some(input) = input {
                writer
                    .write_all(input)
                    .await
                    .map_err(|error| format!("SSH stdin send error: {error}"))?;
                writer
                    .shutdown()
                    .await
                    .map_err(|error| format!("SSH stdin EOF error: {error}"))?;
            }
            Ok::<(), String>(())
        };
        tokio::pin!(send_input);

        let mut input_result = input.is_none().then_some(Ok(()));
        let mut exit_status = None;
        loop {
            tokio::select! {
                // Observe ready stdin completion before interpreting channel closure.
                biased;
                result = &mut send_input, if input_result.is_none() => {
                    input_result = Some(result);
                }
                message = channel.wait() => match message {
                    Some(ChannelMsg::Data { data }) => on_data(0, &data),
                    Some(ChannelMsg::ExtendedData { data, .. }) => on_data(1, &data),
                    Some(ChannelMsg::ExitStatus { exit_status: code }) => exit_status = Some(code),
                    Some(ChannelMsg::Failure) => return Err("SSH exec request was rejected".to_string()),
                    None => break,
                    _ => {}
                }
            }
        }
        owned.close().await;
        // Keep a remote failure's status and stderr even if it stopped reading
        // stdin. A reported success still requires complete input delivery.
        if !matches!(exit_status, Some(code) if code != 0) {
            input_result
                .ok_or_else(|| "SSH channel closed before stdin was fully sent".to_string())??;
        }
        Ok(exit_status)
    })
    .await
    .map_err(|_| {
        format!(
            "Command timed out after {}s. Consider breaking it into smaller steps.",
            timeout.as_secs()
        )
    })?
}

#[cfg(test)]
mod tests;
