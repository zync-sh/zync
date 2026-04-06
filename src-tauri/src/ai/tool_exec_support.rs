use tauri::{AppHandle, Emitter};

use crate::ai::types::ToolOutputEvent;

const DANGEROUS_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "rm --no-preserve-root",
    "mkfs",
    "> /dev/sda",
    "> /dev/nvme",
    "dd if=/dev/zero of=/dev/",
    "dd if=/dev/random of=/dev/",
    ":(){ :|:& };:",
    "chmod -R 777 /",
    "chown -R root /",
    "format c:",
    "del /f /s /q c:\\windows",
    "rd /s /q c:\\",
    "shutdown /f",
];

const MAX_INPUT_LEN: usize = 4_096;

pub(crate) fn is_dangerous_command(cmd: &str) -> bool {
    let normalized = cmd
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if DANGEROUS_PATTERNS
        .iter()
        .any(|pattern| normalized.contains(pattern))
    {
        return true;
    }

    let tokens: Vec<&str> = normalized.split_whitespace().collect();
    let invokes_rm = tokens.iter().any(|token| *token == "rm" || token.ends_with("/rm"));
    let has_recursive = tokens.iter().any(|token| {
        token.starts_with('-') && (
            token.chars().skip(1).any(|c| c == 'r')
                || token == &"--recursive"
                || token.contains("recursive")
        )
    });
    let has_force = tokens.iter().any(|token| {
        token.starts_with('-') && (
            token.chars().skip(1).any(|c| c == 'f')
                || token == &"--force"
                || token.contains("force")
        )
    });
    let targets_root = tokens.iter().any(|token| *token == "/" || *token == "/*");

    invokes_rm && has_recursive && has_force && targets_root
}

pub(crate) fn validate_path(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path must not be empty.".into());
    }
    if trimmed == "/" || trimmed == "." || trimmed == ".." {
        return Err(format!(
            "Path '{}' is too broad - provide a specific file or directory.",
            trimmed
        ));
    }
    if trimmed.len() > MAX_INPUT_LEN {
        return Err(format!(
            "Path is too long ({} chars, max {}).",
            trimmed.len(),
            MAX_INPUT_LEN
        ));
    }
    Ok(())
}

pub(crate) fn validate_command(cmd: &str) -> Result<(), String> {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return Err("Command must not be empty.".into());
    }
    if trimmed.len() > MAX_INPUT_LEN {
        return Err(format!(
            "Command is too long ({} chars, max {}).",
            trimmed.len(),
            MAX_INPUT_LEN
        ));
    }
    Ok(())
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Truncates overly large terminal outputs to prevent blowing out the AI context window.
/// If `session_dir` and `tool_call_id` are provided, the full output is securely written 
/// to the session's artifact folder before truncation, and a file path reference is 
/// injected directly into the truncated string to inform the AI.
pub(crate) fn cap_output(
    session_dir: Option<&std::path::Path>,
    tool_call_id: Option<&str>,
    output: String,
) -> String {
    const MAX_OUTPUT_LEN: usize = 8_192;
    const HALF: usize = MAX_OUTPUT_LEN / 2; // Exact 4 KB each for head and tail

    if output.len() <= MAX_OUTPUT_LEN {
        return output;
    }

    // Find a safe UTF-8 boundary at or after the HALF mark for the head.
    let head_end = output
        .char_indices()
        .map(|(i, _)| i)
        .find(|&i| i >= HALF)
        .unwrap_or(output.len());

    // Find a safe UTF-8 boundary at or before (len - HALF) for the tail.
    let tail_target = output.len().saturating_sub(HALF);
    let tail_start = output
        .char_indices()
        .map(|(i, _)| i)
        .find(|&i| i >= tail_target)
        .unwrap_or(output.len());

    let size_kb = output.len() / 1024;
    
    let path_msg = match (session_dir, tool_call_id) {
        (Some(dir), Some(id)) => {
            if let Some(path) = crate::ai::brain::save_artifact(dir, id, &output) {
                format!(" - if you need more details you can see {}", path)
            } else {
                String::new()
            }
        }
        _ => " - use smaller commands to read selectively".to_string()
    };

    format!(
        "{}\n\n[truncated: output was {}KB{}]\n\n{}",
        &output[..head_end],
        size_kb,
        path_msg,
        &output[tail_start..],
    )
}

pub(crate) fn emit_output(app: &AppHandle, run_id: &str, tool_call_id: &str, chunk: &str) {
    let _ = app.emit(
        "ai:tool-output",
        ToolOutputEvent {
            run_id: run_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            chunk: chunk.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_dangerous_command_patterns() {
        assert!(is_dangerous_command("rm -rf /tmp/build && rm -rf /"));
        assert!(is_dangerous_command("rm  -r   -f   /"));
        assert!(!is_dangerous_command("rm report.txt"));
        assert!(!is_dangerous_command("ls -la"));
    }

    #[test]
    fn validates_paths() {
        assert!(validate_path("/tmp/file.txt").is_ok());
        assert!(validate_path("/").is_err());
    }

    #[test]
    fn validates_commands() {
        assert!(validate_command("echo hello").is_ok());
        assert!(validate_command("   ").is_err());
    }

    #[test]
    fn quotes_shell_strings() {
        assert_eq!(shell_quote("simple"), "'simple'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn caps_large_output_with_head_and_tail() {
        let long = format!("{}{}{}", "H".repeat(5000), "M".repeat(5000), "T".repeat(5000));
        let capped = cap_output(None, None, long);
        assert!(capped.starts_with("HHHH"));
        assert!(capped.ends_with("TTTT"));
        assert!(capped.contains("[truncated"));
    }

    #[test]
    fn preserves_short_output() {
        let short = "hello world".to_string();
        assert_eq!(cap_output(None, None, short.clone()), short);
    }

    #[test]
    fn tests_saves_artifact_to_disk() {
        let tmp = std::env::temp_dir().join(format!("zync_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();

        let long = "A".repeat(10000);
        let capped = cap_output(Some(&tmp), Some("call_123"), long.clone());

        // Verify the message contains the path
        assert!(capped.contains("if you need more details you can see"));
        assert!(capped.contains("call_123.txt"));

        // Verify the file actually exists and contains the full content
        let artifact_path = tmp.join("artifacts").join("call_123.txt");
        assert!(artifact_path.exists());
        let saved_content = std::fs::read_to_string(artifact_path).unwrap();
        assert_eq!(saved_content, long);

        // Cleanup
        let _ = std::fs::remove_dir_all(tmp);
    }
}
