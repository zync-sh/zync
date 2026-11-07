use anyhow::{anyhow, bail, Result};
use russh::client::{AuthResult, Handle, Handler, KeyboardInteractiveAuthResponse};
use russh::MethodKind;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::sync::oneshot;
use tokio::time::{timeout_at, Instant};

const VERIFICATION_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_ROUNDS: usize = 12;
const MAX_PROMPTS: usize = 16;
const MAX_ANSWER_BYTES: usize = 4096;
const ADDITIONAL_AUTH_REQUIRED: &str =
    "The SSH server requires an additional authentication method that Zync does not support";

/// A foreground command's reply channel, kept separate from saved host configuration.
pub(crate) struct Attempt {
    id: String,
    webview_label: String,
    channel: Channel<Challenge>,
}

impl Attempt {
    /// Route prompts to the renderer that initiated the foreground command.
    pub(crate) fn new(
        id: String,
        webview: tauri::Webview,
        channel: tauri::ipc::JavaScriptChannelId,
    ) -> Self {
        Self {
            id,
            webview_label: webview.label().to_owned(),
            channel: channel.channel_on(webview),
        }
    }

    #[cfg(test)]
    /// Supply a native in-process channel without a WebView for encrypted transport fixtures.
    pub(super) fn for_test(id: &str, webview_label: &str, channel: Channel<Challenge>) -> Self {
        Self {
            id: id.into(),
            webview_label: webview_label.into(),
            channel,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Challenge {
    attempt_id: String,
    request_id: String,
    host: String,
    port: u16,
    username: String,
    title: String,
    instructions: String,
    prompts: Vec<ChallengePrompt>,
}

#[derive(Serialize)]
struct ChallengePrompt {
    index: usize,
    label: String,
    echo: bool,
}

struct PendingReply {
    attempt_id: String,
    webview_label: String,
    prompt_count: usize,
    deadline: Instant,
    sender: oneshot::Sender<Option<Vec<String>>>,
}

/// Keeps one-shot replies bound to the exact verified transport and challenge round.
#[derive(Default)]
pub(crate) struct PromptBroker {
    pending: Mutex<HashMap<String, PendingReply>>,
}

struct PendingRound<'a> {
    broker: &'a PromptBroker,
    request_id: String,
}

impl Drop for PendingRound<'_> {
    /// A timeout, task abort, or disconnected renderer retires the same pending round.
    fn drop(&mut self) {
        self.broker.pending().remove(&self.request_id);
    }
}

impl PromptBroker {
    /// Access the pending one-shot registry without holding the lock across async work.
    fn pending(&self) -> MutexGuard<'_, HashMap<String, PendingReply>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Consume only a valid response for this attempt and round. Null cancels the exchange.
    pub(crate) fn reply(
        &self,
        webview_label: &str,
        attempt_id: &str,
        request_id: &str,
        responses: Option<Vec<String>>,
    ) -> Result<()> {
        let mut pending = self.pending();
        let entry = pending
            .get(request_id)
            .filter(|entry| {
                entry.webview_label == webview_label
                    && entry.attempt_id == attempt_id
                    && Instant::now() < entry.deadline
            })
            .ok_or_else(|| anyhow!("This SSH verification prompt has ended"))?;
        if let Some(answers) = responses.as_ref() {
            if answers.len() != entry.prompt_count {
                bail!("Invalid SSH verification response count");
            }
            if answers.iter().any(|answer| answer.len() > MAX_ANSWER_BYTES) {
                bail!("SSH verification responses must be at most {MAX_ANSWER_BYTES} bytes");
            }
        }
        let entry = pending
            .remove(request_id)
            .ok_or_else(|| anyhow!("This SSH verification prompt has ended"))?;
        drop(pending);
        entry
            .sender
            .send(responses)
            .map_err(|_| anyhow!("This SSH verification prompt has ended"))
    }

    /// Continue an accepted primary factor on the same verified SSH session.
    pub(super) async fn complete<H: Handler>(
        &self,
        session: &mut Handle<H>,
        config: &crate::types::ConnectionConfig,
        primary_result: AuthResult,
        attempt: Option<&Attempt>,
    ) -> Result<()> {
        match primary_result {
            AuthResult::Success => return Ok(()),
            AuthResult::Failure {
                partial_success: true,
                remaining_methods,
            } if remaining_methods.contains(&MethodKind::KeyboardInteractive) => {}
            AuthResult::Failure {
                partial_success: true,
                ..
            } => bail!(ADDITIONAL_AUTH_REQUIRED),
            AuthResult::Failure { .. } => bail!("Authentication failed"),
        }
        let attempt = attempt.ok_or_else(|| {
            anyhow!("SSH verification required. Reconnect to this host to respond.")
        })?;
        let deadline = Instant::now() + VERIFICATION_TIMEOUT;
        timeout_at(deadline, self.exchange(session, config, attempt, deadline))
            .await
            .map_err(|_| anyhow!("SSH verification timed out"))?
    }

    /// Relay the server's ordered challenge rounds until authentication completes.
    async fn exchange<H: Handler>(
        &self,
        session: &mut Handle<H>,
        config: &crate::types::ConnectionConfig,
        attempt: &Attempt,
        deadline: Instant,
    ) -> Result<()> {
        let mut result = session
            .authenticate_keyboard_interactive_start(&config.username, None::<String>)
            .await?;
        let mut rounds = 0;
        loop {
            let (title, instructions, prompts) = match result {
                KeyboardInteractiveAuthResponse::Success => return Ok(()),
                KeyboardInteractiveAuthResponse::Failure {
                    partial_success: true,
                    ..
                } => bail!(ADDITIONAL_AUTH_REQUIRED),
                KeyboardInteractiveAuthResponse::Failure { .. } => {
                    bail!("SSH verification was rejected")
                }
                KeyboardInteractiveAuthResponse::InfoRequest {
                    name,
                    instructions,
                    prompts,
                } => (
                    display_text(&name, 256),
                    display_text(&instructions, 4096),
                    prompts,
                ),
            };
            if rounds == MAX_ROUNDS {
                bail!("The SSH server sent too many verification rounds");
            }
            rounds += 1;
            if prompts.len() > MAX_PROMPTS {
                bail!("The SSH server sent too many verification prompts");
            }
            let responses = if prompts.is_empty() && title.is_empty() && instructions.is_empty() {
                Vec::new()
            } else {
                self.ask(
                    attempt,
                    Challenge {
                        attempt_id: attempt.id.clone(),
                        request_id: uuid::Uuid::new_v4().to_string(),
                        host: config.host.clone(),
                        port: config.port,
                        username: config.username.clone(),
                        title,
                        instructions,
                        prompts: prompts
                            .into_iter()
                            .enumerate()
                            .map(|(index, prompt)| ChallengePrompt {
                                index,
                                label: display_text(&prompt.prompt, 1024),
                                echo: prompt.echo,
                            })
                            .collect(),
                    },
                    deadline,
                )
                .await?
            };
            result = session
                .authenticate_keyboard_interactive_respond(responses)
                .await?;
        }
    }

    /// Register a round before emitting it and release its ownership when the wait ends.
    async fn ask(
        &self,
        attempt: &Attempt,
        challenge: Challenge,
        deadline: Instant,
    ) -> Result<Vec<String>> {
        let (sender, receiver) = oneshot::channel();
        let round = PendingRound {
            broker: self,
            request_id: challenge.request_id.clone(),
        };
        self.pending().insert(
            round.request_id.clone(),
            PendingReply {
                attempt_id: challenge.attempt_id.clone(),
                webview_label: attempt.webview_label.clone(),
                prompt_count: challenge.prompts.len(),
                deadline,
                sender,
            },
        );
        attempt
            .channel
            .send(challenge)
            .map_err(|_| anyhow!("SSH verification prompt could not be delivered"))?;
        receiver
            .await?
            .ok_or_else(|| anyhow!("SSH verification cancelled"))
    }
}

/// Keep server text inert, including terminal controls and explicit bidi overrides.
fn display_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars().filter(|ch| {
        (*ch == '\n' || *ch == '\t' || !ch.is_control())
            && !matches!(*ch, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    });
    let mut text: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        text.push('…');
    }
    text
}
