use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::ai::types::{AgentMessage, AgentPlanEvent, AgentPlanStep, AgentThinkingEvent, AssistantResponse};
use crate::ai::{tools, AiConfig};
use crate::commands::AppState;

pub(super) const PLANNING_SYSTEM_PROMPT: &str = r#"You are an autonomous server agent in PLANNING MODE.

CRITICAL: You communicate ONLY through tool calls. NEVER write text explanations or markdown.

YOUR WORKFLOW (follow exactly):
1. Call run_command / read_file / list_files (0-4 times) to investigate the current state.
   - Only read-only commands. NEVER write, delete, restart, or modify anything.
2. Call propose_plan ONCE with your complete plan. This call is MANDATORY.
   - summary: one sentence describing what the plan accomplishes.
   - steps: array where each step has:
       id (e.g. "step-1"), title, reason,
       risk MUST be exactly one of: "low" | "medium" | "high",
       requiresApproval: true for destructive/service-impacting steps.

You MUST call propose_plan as a FUNCTION/TOOL CALL - never write the plan as text.
If you do not call propose_plan, the planning phase will fail.
Minimal steps are fine - even a single step is valid."#;

pub(super) async fn run_planning_phase<F, G>(
    app: &AppHandle,
    state: &AppState,
    run_id: &str,
    conn_id: Option<&str>,
    context_preamble: &str,
    goal: &str,
    config: &AiConfig,
    cancel: &Arc<AtomicBool>,
    call_provider: F,
    poll_until_cancel: G,
) -> Result<Option<Vec<AgentPlanStep>>, String>
where
    F: for<'a> Fn(
        &'a AppHandle,
        &'a str,
        &'a [AgentMessage],
        &'a AiConfig,
        &'a str,
        serde_json::Value,
    ) -> Pin<Box<dyn Future<Output = Result<AssistantResponse, String>> + Send + 'a>>,
    G: for<'a> Fn(&'a Arc<AtomicBool>) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>,
{
    let init_msg = format!("{}\n\nGoal: {}", context_preamble, goal);
    let mut messages: Vec<AgentMessage> = vec![AgentMessage::User(init_msg)];
    let mut iterations = 0usize;
    const MAX_PLAN_ITERATIONS: usize = 6;

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        if iterations >= MAX_PLAN_ITERATIONS {
            return Err(format!(
                "Planning exceeded {MAX_PLAN_ITERATIONS} steps without producing a plan. Try a more capable model."
            ));
        }
        iterations += 1;

        let response = tokio::select! {
            result = call_provider(
                app,
                run_id,
                &messages,
                config,
                PLANNING_SYSTEM_PROMPT,
                tools::planning_tool_schemas(config),
            ) => result?,
            _ = poll_until_cancel(cancel) => {
                return Ok(None);
            }
        };

        if !response.thinking_streamed {
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

        messages.push(AgentMessage::Assistant {
            text: response.text.clone(),
            tool_calls: response.tool_calls.clone(),
        });

        if response.tool_calls.is_empty() {
            messages.push(AgentMessage::User(
                "IMPORTANT: You MUST call the propose_plan FUNCTION/TOOL ? do not write the plan as text. Call propose_plan({\"summary\": \"...\", \"steps\": [{\"id\": \"step-1\", \"title\": \"...\", \"reason\": \"...\", \"risk\": \"low\", \"requiresApproval\": false}]}) now.".into(),
            ));
            continue;
        }

        let mut proposed = false;
        for tool_call in &response.tool_calls {
            if cancel.load(Ordering::Relaxed) {
                return Ok(None);
            }

            match tool_call.name.as_str() {
                "propose_plan" => {
                    proposed = true;

                    let summary = tool_call
                        .input
                        .get("summary")
                        .and_then(|value| value.as_str())
                        .unwrap_or("Execution plan")
                        .to_string();

                    let steps: Vec<AgentPlanStep> = tool_call
                        .input
                        .get("steps")
                        .and_then(|value| serde_json::from_value::<Vec<serde_json::Value>>(value.clone()).ok())
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|mut step| {
                            let normalized_risk = step
                                .get("risk")
                                .and_then(|risk| risk.as_str())
                                .map(|risk| match risk.to_lowercase().as_str() {
                                    "medium" => "medium",
                                    "high" => "high",
                                    _ => "low",
                                })
                                .unwrap_or("low");
                            step["risk"] = serde_json::json!(normalized_risk);
                            serde_json::from_value::<AgentPlanStep>(step).ok()
                        })
                        .collect();

                    if steps.is_empty() {
                        messages.push(AgentMessage::ToolResult {
                            tool_call_id: tool_call.id.clone(),
                            tool_name: "propose_plan".into(),
                            content: "Error: plan must have at least one step.".into(),
                        });
                        break;
                    }

                    let plan_id = uuid::Uuid::new_v4().to_string();
                    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
                    {
                        let mut checkpoints = state.agent_checkpoints.lock().await;
                        checkpoints.insert(plan_id.clone(), tx);
                    }

                    let _ = app.emit(
                        "ai:agent-plan",
                        AgentPlanEvent {
                            run_id: run_id.to_string(),
                            plan_id: plan_id.clone(),
                            summary,
                            steps: steps.clone(),
                        },
                    );

                    let approved = tokio::select! {
                        result = rx => result.unwrap_or(false),
                        _ = poll_until_cancel(cancel) => false,
                    };
                    {
                        let mut checkpoints = state.agent_checkpoints.lock().await;
                        checkpoints.remove(&plan_id);
                    }

                    if approved {
                        return Ok(Some(steps));
                    }
                    return Ok(None);
                }
                "run_command" | "read_file" | "list_files" => {
                    let tool_ctx = tools::ToolContext {
                        app,
                        connections: &state.connections,
                        connection_id: conn_id,
                        run_id,
                        session_dir: None,
                    };
                    let result = tokio::select! {
                        value = tools::execute_tool(&tool_ctx, tool_call) => value,
                        _ = poll_until_cancel(cancel) => return Ok(None),
                    };
                    let content = match result {
                        Ok(output) => output,
                        Err(error) => format!("[Error] {}", error),
                    };
                    messages.push(AgentMessage::ToolResult {
                        tool_call_id: tool_call.id.clone(),
                        tool_name: tool_call.name.clone(),
                        content,
                    });
                }
                other => {
                    messages.push(AgentMessage::ToolResult {
                        tool_call_id: tool_call.id.clone(),
                        tool_name: other.to_string(),
                        content: format!(
                            "Tool '{}' is not available in planning mode. Use only run_command (read-only), read_file, list_files, or propose_plan.",
                            other
                        ),
                    });
                }
            }
        }

        if proposed {
            messages.push(AgentMessage::User(
                "Your plan had no steps. Please call propose_plan again with at least one step.".into(),
            ));
        }
    }
}

pub(super) fn build_plan_context(steps: &[AgentPlanStep]) -> String {
    steps
        .iter()
        .enumerate()
        .map(|(index, step)| {
            let cmd_part = step
                .command
                .as_deref()
                .map(|command| format!("\n   Command: {}", command))
                .unwrap_or_default();
            format!("Step {}: {} - {}{}", index + 1, step.title, step.reason, cmd_part)
        })
        .collect::<Vec<_>>()
        .join("\n")
}
