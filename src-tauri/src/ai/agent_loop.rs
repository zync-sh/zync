//! Agentic loop: calls the AI with tools, executes tool calls, feeds results
//! back, and repeats until the AI says it is done or the run is cancelled.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use super::agent_planning::{build_plan_context, run_planning_phase};
use super::agent_loop_support::{
    build_action_entry,
    is_capability_refusal,
    is_conversational_question,
    is_sensitive_write_path,
    needs_destructive_approval,
    needs_package_approval,
    needs_service_approval,
    parse_text_tool_calls,
};

use crate::ai::types::{
    AgentCheckpointEvent, AgentDoneEvent, AgentErrorEvent, AgentMessage, AgentRunRequest,
    AgentThinkingEvent, AssistantResponse, ToolDoneEvent, ToolStartEvent,
};
use crate::ai::{AiConfig, tools};
use crate::commands::AppState;

/// Maximum tool calls across the whole run (prevents infinite loops).
const MAX_ITERATIONS: usize = 25;

/// System prompt used exclusively for agent (tool-use) mode.
/// Separate from the TOON-format Ask-mode system prompt.
const AGENT_SYSTEM_PROMPT: &str = "\
You are an autonomous server agent with access to tools. \
Your job is to accomplish the user's goal by running shell commands, reading and writing files, \
and listing directories on the connected server.\n\
\n\
CRITICAL BEHAVIOR RULE:\n\
You are an AUTONOMOUS EXECUTOR — you ALWAYS use your tools to perform tasks directly.\n\
You NEVER say \"I don't have the capability\", \"I cannot access\", or give the user manual \
instructions to follow. If you receive a task, respond ONLY with tool calls that accomplish it. \
Never explain what the user should do themselves — DO it yourself using the tools.\n\
\n\
MANDATORY safety rules — you MUST call ask_user before ANY of the following:\n\
\n\
FILE DELETION / OVERWRITE (any form, with or without flags):\n\
  rm, unlink, shred, srm, wipe, truncate, dd of=<file/device>\n\
  Examples that require ask_user: `rm file.txt`, `rm -f conf`, `rm -rf dir/`, `truncate -s 0 f`\n\
\n\
SERVICE / PROCESS MANAGEMENT:\n\
  systemctl stop/disable/mask/kill, service <name> stop/restart,\n\
  kill, pkill, killall, reboot, shutdown, halt, poweroff\n\
\n\
SYSTEM / USER CHANGES:\n\
  userdel, groupdel, usermod, passwd, visudo, crontab -r,\n\
  iptables/ufw/firewall-cmd with delete/drop/flush rules,\n\
  ip link set down, ifconfig <iface> down\n\
\n\
PACKAGE MANAGEMENT (system-level):\n\
  apt/apt-get/yum/dnf/pacman/brew/snap install|remove|purge|uninstall|upgrade\n\
\n\
NEVER call ask_user just to ask \"what would you like to do next?\" — \
ask_user is ONLY for the four categories above. Treating it as a conversational tool \
causes an immediate done signal.\n\
\n\
Execution guidelines:\n\
- Start by understanding the current state before making changes (read/list first).\n\
- Prefer minimal, targeted changes over broad operations.\n\
- Be concise in your reasoning text — one sentence per tool call is enough.\n\
- When the goal is complete, write a concise summary (2-4 sentences) covering: what was found/changed, the outcome, and any key values (PIDs, paths, versions). Then stop — make NO more tool calls.\n\
- Do NOT use `echo` or `printf` to output your summary — write it as text only.\n\
- Do NOT call tools named 'done', 'finish', 'summary', 'exit', 'complete', or 'stop'. These do not exist.\n\
- Do not apologise, ask follow-up questions, or offer to do more work.\n\
- Respond ONLY via tool calls and short reasoning text. No markdown headers, no lists.";

// ── Entry point ───────────────────────────────────────────────────────────────

pub async fn run(
    app: &AppHandle,
    state: &AppState,
    request: AgentRunRequest,
    config: AiConfig,
    cancel: Arc<AtomicBool>,
) {
    let run_id = request.run_id.clone();
    let result = run_inner(app, state, request, config, cancel).await;

    if let Err(e) = result {
        let _ = app.emit(
            "ai:agent-error",
            AgentErrorEvent {
                run_id,
                message: e,
            },
        );
    }
}

async fn run_inner(
    app: &AppHandle,
    state: &AppState,
    mut request: AgentRunRequest,
    config: AiConfig,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let run_id = &request.run_id;
    // The frontend sends connectionId="local" for local tabs and a real UUID for SSH
    // connections. Normalize "local" → None so all downstream code treats it as a
    // local run (no SSH lookup, exec_local path in tools).
    if request.connection_id.as_deref() == Some("local") {
        request.connection_id = None;
    }
    let conn_id    = request.connection_id.as_deref();
    let conn_label = request.connection_label.as_deref();
    let model_name = config.model.as_deref().unwrap_or("unknown");

    let (session_dir, session_ts) = match super::brain::init_session(app, &request.goal, conn_id, conn_label) {
        Some((dir, ts)) => (Some(dir), Some(ts)),
        None => (None, None),
    };

    // Override frontend OS/shell guesses with values detected at connect time.
    // The frontend can only guess (e.g. always sends "Linux"/"bash" for SSH),
    // whereas the backend probed the real environment when the connection was established.
    if let Some(cid) = conn_id {
        let conns = state.connections.lock().await;
        if let Some(handle) = conns.get(cid) {
            if let Some(ref os) = handle.detected_os {
                request.context.os = Some(os.clone());
            }
            if let Some(ref shell) = handle.detected_shell {
                request.context.shell = Some(shell.clone());
            }
        }
        // Lock released here — do not hold it across the agent loop.
    }

    // Build context line injected as the first user message
    let context_preamble = build_context_preamble(&request);

    // ── Planning phase ────────────────────────────────────────────────────────
    // Investigate the environment, show the user a plan, and wait for approval
    // before any mutations. On rejection, abort the run cleanly.
    // If an approved plan was passed in (retry after failure), skip re-planning.
    let approved_steps = if let Some(steps) = request.approved_plan.take().filter(|s| !s.is_empty()) {
        // Reuse the previously approved plan — user is continuing after a failed run.
        steps
    } else {
        match run_planning_phase(
            app,
            state,
            run_id,
            conn_id,
            &context_preamble,
            &request.goal,
            &config,
            &cancel,
            |app, run_id, messages, config, system, tool_schemas| {
                Box::pin(call_provider(app, run_id, messages, config, system, tool_schemas))
            },
            |cancel| Box::pin(poll_until_cancel(cancel)),
        ).await? {
            Some(steps) => steps,
            None => {
                let was_cancelled = cancel.load(Ordering::Relaxed);
                let summary = if was_cancelled {
                    "Stopped by user."
                } else {
                    "Plan rejected — no changes were made."
                };
                let session_path = if let Some(dir) = &session_dir {
                    if let Some(ts) = &session_ts {
                        super::brain::finalize_session(
                            dir, ts, run_id, &request.goal, conn_label, model_name,
                            false, summary, &[],
                        );
                    }
                    Some(dir.to_string_lossy().to_string())
                } else {
                    None
                };
                emit_done(app, run_id, false, summary, vec![], session_path);
                return Ok(());
            }
        }
    };

    // Inject the approved plan as context for the execution phase so the AI
    // follows the agreed steps rather than re-planning from scratch.
    let plan_context = build_plan_context(&approved_steps);
    let goal_message = format!(
        "{}\n\nApproved plan:\n{}\n\nGoal: {} \
         \nProceed with execution. Follow the plan steps in order. \
         Do not deviate or add extra steps.",
        context_preamble, plan_context, request.goal
    );

    // Seed conversation with prior-run history so the agent has multi-turn context.
    // History entries are user goals + agent done-summaries from previous runs.
    let mut messages: Vec<AgentMessage> = request
        .history
        .iter()
        .map(|entry| match entry.role.as_str() {
            "assistant" => AgentMessage::Assistant {
                text: Some(entry.text.clone()),
                tool_calls: vec![],
            },
            _ => AgentMessage::User(entry.text.clone()),
        })
        .collect();

    messages.push(AgentMessage::User(goal_message));
    let mut iterations = 0usize;
    // Accumulates a human-readable action log shown in the DONE bubble.
    let mut action_log: Vec<String> = Vec::new();

    // Saves the brain session folder and emits the done event.
    // Using a macro because closures can't move out of captured &mut action_log.
    macro_rules! finish {
        ($success:expr, $summary:expr, $actions:expr) => {{
            let session_path = if let Some(dir) = &session_dir {
                if let Some(ts) = &session_ts {
                    super::brain::finalize_session(
                        dir,
                        ts,
                        run_id,
                        &request.goal,
                        conn_label,
                        model_name,
                        $success,
                        $summary,
                        &$actions,
                    );
                }
                Some(dir.to_string_lossy().to_string())
            } else {
                None
            };
            emit_done(app, run_id, $success, $summary, $actions, session_path);
        }};
    }
    // Set to true when the AI calls ask_user and the user approves, so the
    // safety-net checkpoint is skipped for the immediately following run_command
    // (the AI already asked — prompting again would be a duplicate).
    let mut skip_next_safety_check = false;

    loop {
        // ── Cancellation check ──
        if cancel.load(Ordering::Relaxed) {
            finish!(false, "Stopped by user.", action_log);
            return Ok(());
        }

        // ── Iteration guard ──
        if iterations >= MAX_ITERATIONS {
            finish!(
                false,
                &format!("Reached the {MAX_ITERATIONS}-step limit. Review what was done and continue manually if needed."),
                action_log
            );
            return Ok(());
        }
        iterations += 1;

        // ── Call AI (with retry) ──
        let response = call_provider_with_retry(
            app, run_id, &messages, &config,
            AGENT_SYSTEM_PROMPT,
            tools::execution_tool_schemas(&config),
            &cancel,
        ).await;
        let response = match response {
            Ok(r) => r,
            Err(_) if cancel.load(Ordering::Relaxed) => {
                finish!(false, "Stopped by user.", action_log);
                return Ok(());
            }
            Err(e) => return Err(e),
        };

        // ── No tool calls → check for text-based tool call fallback ──
        // Some models (e.g. Mistral in degraded mode) output tool calls as raw JSON text
        // like: [{"name":"run_command","arguments":{...}}]
        // If we detect that pattern, parse and inject the tool calls so execution continues.
        let response = if response.tool_calls.is_empty() {
            if let Some(text) = &response.text {
                if let Some(calls) = parse_text_tool_calls(text) {
                    crate::ai::types::AssistantResponse {
                        text: None,
                        tool_calls: calls,
                        thinking_streamed: response.thinking_streamed,
                    }
                } else {
                    // Detect model refusing to use tools ("I don't have the capability...")
                    // and surface it as a clear error rather than silently completing.
                    if is_capability_refusal(text) {
                        return Err(
                            "The model responded with instructions instead of using tools. \
                             Try a more capable model (e.g. claude-sonnet, gpt-4o, mistral-large)."
                                .to_string(),
                        );
                    }
                    // Use the AI's text as the DONE summary regardless of whether it was
                    // already streamed as thinking chunks. The DONE bubble shows a compact
                    // summary card, while the thinking bubble above provides the live view —
                    // both are useful (live = full reasoning, DONE = permanent record).
                    let summary = if text.trim().is_empty() { "Done." } else { text };
                    finish!(true, summary, action_log);
                    return Ok(());
                }
            } else {
                finish!(true, "Done.", action_log);
                return Ok(());
            }
        } else {
            response
        };

        // ── Emit thinking text ──
        // Streaming providers (Claude, OpenAI-compat) already emitted chunks during
        // call_provider — skip to avoid showing the text twice.
        // Also skip if there are no tool calls (we're about to finish and use this text as summary).
        if !response.thinking_streamed && !response.tool_calls.is_empty() {
            if let Some(text) = &response.text {
                if !text.trim().is_empty() {
                    let _ = app.emit(
                        "ai:agent-thinking",
                        AgentThinkingEvent {
                            run_id: run_id.to_string(),
                            text: text.clone(),
                        },
                    );
                }
            }
        }

        // ── Record assistant turn ──
        messages.push(AgentMessage::Assistant {
            text: response.text.clone(),
            tool_calls: response.tool_calls.clone(),
        });

        // ── Execute each tool call ──
        for tool_call in &response.tool_calls {
            if cancel.load(Ordering::Relaxed) {
                finish!(false, "Stopped by user.", std::mem::take(&mut action_log));
                return Ok(());
            }

            // ask_user is handled here, not in tools.rs
            if tool_call.name == "ask_user" {
                let question = tool_call
                    .input
                    .get("question")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Do you want to continue?");

                // Safety net: if the AI is just asking "what next?" (conversational),
                // treat it as a natural completion rather than a real checkpoint.
                if is_conversational_question(question) {
                    let summary = response.text.clone().unwrap_or_else(|| question.to_string());
                    finish!(true, &summary, std::mem::take(&mut action_log));
                    return Ok(());
                }

                let proceed =
                    emit_checkpoint(app, state, run_id, &tool_call.id, question, None, &cancel).await;

                let result_text = if proceed {
                    "User approved. Continue."
                } else {
                    cancel.store(true, Ordering::Relaxed);
                    "User declined. Stop."
                };

                messages.push(AgentMessage::ToolResult {
                    tool_call_id: tool_call.id.clone(),
                    tool_name: "ask_user".to_string(),
                    content: result_text.to_string(),
                });

                if !proceed {
                    finish!(false, "Stopped at user request.", std::mem::take(&mut action_log));
                    return Ok(());
                }
                // User just approved — the AI will call run_command next.
                // Skip the safety-net checkpoint for that command to avoid a duplicate prompt.
                skip_next_safety_check = true;
                continue;
            }

            // Auto-checkpoint for commands that could destroy data or modify the system.
            // The AI should call ask_user first, but this is a safety net for cases where it
            // forgets or is running a smaller model that doesn't follow instructions well.
            if tool_call.name == "run_command" {
                let cmd = tool_call.input.get("command").and_then(|v| v.as_str()).unwrap_or("");

                // Check session whitelist first — whitelisted commands skip all safety checks.
                let scope = conn_id.unwrap_or("local");
                let is_whitelisted = {
                    let wl = state.command_whitelist.lock().await;
                    wl.get(scope).map_or(false, |set: &std::collections::HashSet<String>| set.contains(cmd))
                };

                // If the AI already called ask_user and the user approved (same or previous turn),
                // consume the skip and don't prompt again.
                let checkpoint_reason: Option<String> = if is_whitelisted || skip_next_safety_check {
                    if skip_next_safety_check { skip_next_safety_check = false; }
                    None
                } else if needs_destructive_approval(cmd) {
                    Some(format!(
                        "The agent wants to run a destructive command:\n\n`{cmd}`\n\nThis may permanently delete or overwrite files. Allow this?"
                    ))
                } else if needs_service_approval(cmd) {
                    Some(format!(
                        "The agent wants to manage a service or process:\n\n`{cmd}`\n\nThis may stop or affect running services. Allow this?"
                    ))
                } else if needs_package_approval(cmd) {
                    Some(format!(
                        "The agent wants to run a package-manager command:\n\n`{cmd}`\n\nAllow this?"
                    ))
                } else {
                    None
                };
                if let Some(question) = checkpoint_reason {
                    let proceed = emit_checkpoint(app, state, run_id, &tool_call.id, &question, Some(cmd), &cancel).await;
                    if !proceed {
                        cancel.store(true, Ordering::Relaxed);
                        messages.push(AgentMessage::ToolResult {
                            tool_call_id: tool_call.id.clone(),
                            tool_name: tool_call.name.clone(),
                            content: "User declined. Stop.".to_string(),
                        });
                        finish!(false, "Stopped at user request.", std::mem::take(&mut action_log));
                        return Ok(());
                    }
                }
            }

            // Gate write_file on sensitive paths and existing-file overwrites.
            if tool_call.name == "write_file" {
                let path = tool_call.input.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let question: Option<String> = if is_sensitive_write_path(path) {
                    Some(format!(
                        "The agent wants to write to a sensitive system path:\n\n`{path}`\n\nThis could affect system configuration or services. Allow this?"
                    ))
                } else {
                    // Check if the file already exists — overwriting is destructive.
                    // Wrap in select! so Stop doesn't block here.
                    let exists = tokio::select! {
                        result = tools::file_exists(app, &state.connections, conn_id, path) => result,
                        _ = poll_until_cancel(&cancel) => false,
                    };
                    if exists {
                        Some(format!(
                            "The agent wants to overwrite an existing file:\n\n`{path}`\n\nThe current contents will be replaced. Allow this?"
                        ))
                    } else {
                        None
                    }
                };
                if let Some(question) = question {
                    let proceed = emit_checkpoint(app, state, run_id, &tool_call.id, &question, None, &cancel).await;
                    if !proceed {
                        cancel.store(true, Ordering::Relaxed);
                        messages.push(AgentMessage::ToolResult {
                            tool_call_id: tool_call.id.clone(),
                            tool_name: tool_call.name.clone(),
                            content: "User declined. Stop.".to_string(),
                        });
                        finish!(false, "Stopped at user request.", std::mem::take(&mut action_log));
                        return Ok(());
                    }
                }
            }

            // Some models call fake completion tools like "done", "finish", "exit", "summary".
            // Treat them as a signal the model is done rather than erroring out.
            if matches!(tool_call.name.as_str(), "done" | "finish" | "exit" | "complete" | "stop" | "summary") {
                let summary = tool_call.input.get("summary")
                    .or_else(|| tool_call.input.get("message"))
                    .or_else(|| tool_call.input.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let final_summary = if summary.is_empty() {
                    response.text.clone().unwrap_or_else(|| "Done.".to_string())
                } else {
                    summary
                };
                finish!(true, &final_summary, std::mem::take(&mut action_log));
                return Ok(());
            }

            // Emit tool-start so frontend can show the block immediately
            let _ = app.emit(
                "ai:tool-start",
                ToolStartEvent {
                    run_id: run_id.to_string(),
                    tool_call_id: tool_call.id.clone(),
                    name: tool_call.name.clone(),
                    input: tool_call.input.clone(),
                },
            );

            // Execute (races against the cancel flag so Stop works mid-tool)
            let tool_ctx = tools::ToolContext {
                app,
                connections: &state.connections,
                connection_id: conn_id,
                run_id,
                session_dir: session_dir.clone(),
            };
            let exec_result = tokio::select! {
                result = tools::execute_tool(&tool_ctx, tool_call) => result,
                _ = poll_until_cancel(&cancel) => Err("Stopped by user.".to_string()),
            };

            let (success, output) = match exec_result {
                Ok(out) => (true, out),
                Err(err) => (false, format!("Error: {}", err)),
            };

            // Emit tool-done
            let _ = app.emit(
                "ai:tool-done",
                ToolDoneEvent {
                    run_id: run_id.to_string(),
                    tool_call_id: tool_call.id.clone(),
                    name: tool_call.name.clone(),
                    success,
                    output: output.clone(),
                },
            );

            // Append to action log for the DONE summary
            let action_entry = build_action_entry(&tool_call.name, &tool_call.input, success);
            if let Some(entry) = action_entry {
                action_log.push(entry);
            }

            // Feed result back to AI
            messages.push(AgentMessage::ToolResult {
                tool_call_id: tool_call.id.clone(),
                tool_name: tool_call.name.clone(),
                content: output,
            });
        }
    }
}

// ── Planning phase ────────────────────────────────────────────────────────────

async fn call_provider(
    app: &AppHandle,
    run_id: &str,
    messages: &[AgentMessage],
    config: &AiConfig,
    system: &str,
    tool_schemas: serde_json::Value,
) -> Result<AssistantResponse, String> {
    match config.provider.as_str() {
        "claude" => {
            crate::ai::providers::claude::call_agent(
                app, run_id, system, messages, config, tool_schemas,
            )
            .await
        }
        "openai" => {
            crate::ai::providers::openai_compat::call_agent(
                app, "OpenAI", "https://api.openai.com/v1", "gpt-4o",
                run_id, system, messages, config, tool_schemas,
            )
            .await
        }
        "groq" => {
            crate::ai::providers::openai_compat::call_agent(
                app, "Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile",
                run_id, system, messages, config, tool_schemas,
            )
            .await
        }
        "mistral" => {
            crate::ai::providers::openai_compat::call_agent(
                app, "Mistral", "https://api.mistral.ai/v1", "mistral-large-latest",
                run_id, system, messages, config, tool_schemas,
            )
            .await
        }
        "gemini" => {
            crate::ai::providers::gemini::call_agent(
                app, run_id, system, messages, config, tool_schemas,
            )
            .await
        }
        "ollama" => {
            crate::ai::providers::ollama::call_agent(
                app, run_id, system, messages, config, tool_schemas,
            )
            .await
        }
        other => Err(format!("Unknown provider: {}", other)),
    }
}

// ── Provider retry ───────────────────────────────────────────────────────────

use super::util::is_retryable_error;

/// Calls `call_provider` with up to 3 retries on transient errors.
/// Uses exponential backoff (1s, 3s, 9s) and races each wait against the cancel flag.
async fn call_provider_with_retry(
    app: &AppHandle,
    run_id: &str,
    messages: &[AgentMessage],
    config: &AiConfig,
    system: &str,
    tool_schemas: serde_json::Value,
    cancel: &Arc<AtomicBool>,
) -> Result<AssistantResponse, String> {
    const MAX_RETRIES: usize = 3;
    const BACKOFF_BASE: u64 = 1; // seconds

    for attempt in 0..=MAX_RETRIES {
        if cancel.load(Ordering::Relaxed) {
            return Err("Stopped by user.".to_string());
        }

        // Wait before retries (not before the first attempt)
        if attempt > 0 {
            let delay_secs = BACKOFF_BASE * 3u64.pow(attempt as u32 - 1); // 1s, 3s, 9s
            let _ = app.emit(
                "ai:agent-thinking",
                AgentThinkingEvent {
                    run_id: run_id.to_string(),
                    text: format!("\n\n*Retrying in {}s (attempt {}/{})...*\n\n", delay_secs, attempt + 1, MAX_RETRIES + 1),
                },
            );

            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(delay_secs)) => {}
                _ = poll_until_cancel(cancel) => {
                    return Err("Stopped by user.".to_string());
                }
            }
        }

        let result = tokio::select! {
            result = call_provider(app, run_id, messages, config, system, tool_schemas.clone()) => result,
            _ = poll_until_cancel(cancel) => {
                return Err("Stopped by user.".to_string());
            }
        };

        match result {
            Ok(response) => return Ok(response),
            Err(e) => {
                if attempt < MAX_RETRIES && is_retryable_error(&e) {
                    continue;
                }
                return Err(e);
            }
        }
    }

    // Unreachable: the loop above either handles retries or returns Err(e) on the last attempt.
    unreachable!("retry loop should always return")
}

// ── Checkpoint (ask_user) ─────────────────────────────────────────────────────

/// Emits a checkpoint event and blocks until the user responds or the run is cancelled.
/// Returns `true` if the user chose to proceed.
/// If the cancel flag is set while waiting, the checkpoint is auto-declined so the loop
/// does not hang when the user presses Stop while an approval prompt is open.
async fn emit_checkpoint(
    app: &AppHandle,
    state: &AppState,
    run_id: &str,
    _tool_call_id: &str,
    question: &str,
    command: Option<&str>,
    cancel: &Arc<AtomicBool>,
) -> bool {
    let checkpoint_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();

    {
        let mut checkpoints = state.agent_checkpoints.lock().await;
        checkpoints.insert(checkpoint_id.clone(), tx);
    }

    let _ = app.emit(
        "ai:agent-checkpoint",
        AgentCheckpointEvent {
            run_id: run_id.to_string(),
            checkpoint_id: checkpoint_id.clone(),
            question: question.to_string(),
            command: command.map(|c| c.to_string()),
        },
    );

    // Race user response against: (a) cancel flag, (b) 5-minute safety timeout.
    // The timeout prevents the task from hanging forever if the app restarts
    // while a checkpoint is open and the oneshot sender is never answered.
    const CHECKPOINT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
    let proceed = tokio::select! {
        result = rx => result.unwrap_or(false),
        _ = poll_until_cancel(cancel) => false,
        _ = tokio::time::sleep(CHECKPOINT_TIMEOUT) => false,
    };

    {
        let mut checkpoints = state.agent_checkpoints.lock().await;
        checkpoints.remove(&checkpoint_id);
    }

    proceed
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn build_context_preamble(req: &AgentRunRequest) -> String {
    let mut parts = Vec::new();

    // Always emit OS and shell so the AI knows what it's working with.
    // Use "unknown" rather than silently omitting — unknown is honest and
    // tells the AI to use conservative, portable commands.
    parts.push(format!("OS: {}", req.context.os.as_deref().unwrap_or("unknown")));
    parts.push(format!("Shell: {}", req.context.shell.as_deref().unwrap_or("unknown")));

    if let Some(cwd) = &req.context.cwd {
        parts.push(format!("CWD: {}", cwd));
    }
    parts.push(format!("Connection: {}", req.context.connection_type));

    if let Some(output) = &req.context.recent_output {
        if !output.trim().is_empty() {
            let trimmed = if output.len() > 500 {
                // Walk forward from `start` until we land on a UTF-8 char boundary.
                // We must NOT index output[start..] directly because `start` may itself
                // be in the middle of a multi-byte codepoint, which would panic.
                let start = output.len().saturating_sub(500);
                let safe_start = (start..=output.len())
                    .find(|&i| output.is_char_boundary(i))
                    .unwrap_or(output.len());
                &output[safe_start..]
            } else {
                output.as_str()
            };
            parts.push(format!("Recent terminal output:\n{}", trimmed));
        }
    }

    parts.join("\n")
}

/// Completes once the cancel flag is set, polling every 250 ms.
async fn poll_until_cancel(cancel: &Arc<AtomicBool>) {
    loop {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn emit_done(
    app: &AppHandle,
    run_id: &str,
    success: bool,
    summary: &str,
    actions: Vec<String>,
    session_path: Option<String>,
) {
    let _ = app.emit(
        "ai:agent-done",
        AgentDoneEvent {
            run_id: run_id.to_string(),
            success,
            summary: summary.to_string(),
            actions,
            session_path,
        },
    );
}
