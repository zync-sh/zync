#![allow(dead_code)]

use crate::ai::TerminalContext;

#[derive(Debug, Clone, Default)]
pub struct AgentContextSummary {
    pub os: String,
    pub shell: String,
    pub cwd: String,
    pub connection_type: String,
}

pub fn summarize_context(context: &TerminalContext) -> AgentContextSummary {
    AgentContextSummary {
        os: context.os.clone().unwrap_or_else(|| "Linux".to_string()),
        shell: context.shell.clone().unwrap_or_else(|| "bash".to_string()),
        cwd: context.cwd.clone().unwrap_or_else(|| "~".to_string()),
        connection_type: context.connection_type.clone(),
    }
}
