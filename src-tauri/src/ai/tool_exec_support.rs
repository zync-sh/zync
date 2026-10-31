use tauri::{AppHandle, Emitter};

use crate::ai::types::ToolOutputEvent;

/// Existing model-context budget; live tool output uses the same bounded prefix.
pub(crate) const MAX_OUTPUT_BYTES: usize = 8_192;
/// Retain at most 128 context windows for a diagnostic artifact, never unlimited output.
pub(crate) const MAX_ARTIFACT_BYTES: usize = 128 * MAX_OUTPUT_BYTES;
/// File diffs share the tool's existing maximum accepted write size.
pub(crate) const MAX_WRITE_BYTES: usize = 512_000;
const HALF_OUTPUT_BYTES: usize = MAX_OUTPUT_BYTES / 2;
const LIVE_TRUNCATION_NOTICE: &str =
    "\n[Live output truncated; the final result contains a bounded preview.]\n";

/// Bounded normalized text, retaining a prefix for artifacts and a tail for context.
/// Per-stream UTF-8 fragments survive packet boundaries without corrupting characters.
#[derive(Debug)]
pub(crate) struct OutputCapture {
    prefix: String,
    tail: String,
    total: u64,
    limit: usize,
    prefix_full: bool,
    pending: [Vec<u8>; 2],
    streamed: usize,
    stream_notice: bool,
    decoding_error: bool,
}

impl OutputCapture {
    /// Creates a capture whose retained prefix is bounded independently of total traffic.
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            prefix: String::new(),
            tail: String::with_capacity(HALF_OUTPUT_BYTES),
            total: 0,
            limit: limit.clamp(MAX_OUTPUT_BYTES, MAX_ARTIFACT_BYTES),
            prefix_full: false,
            pending: Default::default(),
            streamed: 0,
            stream_notice: false,
            decoding_error: false,
        }
    }

    /// Drains arbitrary input while keeping decoding scratch and retained text bounded.
    pub(crate) fn push(&mut self, stream: u32, bytes: &[u8]) {
        let index = usize::from(stream != 0);
        for chunk in bytes.chunks(MAX_OUTPUT_BYTES) {
            let mut pending = std::mem::take(&mut self.pending[index]);
            pending.extend_from_slice(chunk);
            let mut cursor = 0;
            let end = loop {
                match std::str::from_utf8(&pending[cursor..]) {
                    Ok(_) => break pending.len(),
                    Err(error) => {
                        cursor += error.valid_up_to();
                        match error.error_len() {
                            Some(length) => {
                                self.decoding_error = true;
                                cursor += length;
                            }
                            None => break cursor,
                        }
                    }
                }
            };
            self.push_text(&String::from_utf8_lossy(&pending[..end]));
            pending.drain(..end);
            self.pending[index] = pending;
        }
    }

    /// Appends already-decoded text without allowing a later chunk to fill a skipped prefix gap.
    pub(crate) fn push_text(&mut self, text: &str) {
        self.total = self.total.saturating_add(text.len() as u64);
        if !self.prefix_full {
            let available = self.limit.saturating_sub(self.prefix.len());
            let end = utf8_floor(text, available.min(text.len()));
            self.prefix.push_str(&text[..end]);
            self.prefix_full = end < text.len();
        }
        if text.len() >= HALF_OUTPUT_BYTES {
            let mut start = text.len() - HALF_OUTPUT_BYTES;
            while !text.is_char_boundary(start) {
                start += 1;
            }
            self.tail.clear();
            self.tail.push_str(&text[start..]);
        } else {
            let excess = (self.tail.len() + text.len()).saturating_sub(HALF_OUTPUT_BYTES);
            let mut start = excess;
            while !self.tail.is_char_boundary(start) {
                start += 1;
            }
            self.tail.drain(..start);
            self.tail.push_str(text);
        }
    }

    /// Completes any unterminated UTF-8 character once the corresponding stream has ended.
    pub(crate) fn flush(&mut self) {
        for index in 0..self.pending.len() {
            let pending = std::mem::take(&mut self.pending[index]);
            self.decoding_error |= !pending.is_empty();
            self.push_text(&String::from_utf8_lossy(&pending));
        }
    }

    /// Returns new live prefix text and one truncation notice, never the unbounded stream.
    pub(crate) fn take_live_chunk(&mut self) -> String {
        let end = utf8_floor(&self.prefix, MAX_OUTPUT_BYTES.min(self.prefix.len()));
        let mut chunk = self.prefix[self.streamed..end].to_owned();
        self.streamed = end;
        if self.total > MAX_OUTPUT_BYTES as u64 && !self.stream_notice {
            chunk.push_str(LIVE_TRUNCATION_NOTICE);
            self.stream_notice = true;
        }
        chunk
    }

    /// Returns the complete captured text only when no content was discarded.
    pub(crate) fn complete_text(&self) -> Option<&str> {
        (self.total == self.prefix.len() as u64).then_some(self.prefix.as_str())
    }

    /// Excludes lossy-decoded or incomplete originals from an exact file-diff preview.
    pub(crate) fn complete_utf8_text(&self) -> Option<&str> {
        if self.decoding_error || self.pending.iter().any(|pending| !pending.is_empty()) {
            None
        } else {
            self.complete_text()
        }
    }

    /// Removes trailing whitespace only when the complete output remains available.
    pub(crate) fn trim_end(&mut self) {
        if self.complete_text().is_some() {
            let length = self.prefix.trim_end().len();
            self.prefix.truncate(length);
            self.total = length as u64;
            let mut start = length.saturating_sub(HALF_OUTPUT_BYTES);
            while !self.prefix.is_char_boundary(start) {
                start += 1;
            }
            self.tail = self.prefix[start..].to_owned();
        }
    }

    /// Concatenates independently drained process streams without reconstructing omitted bytes.
    pub(crate) fn append(&mut self, mut other: Self) {
        self.flush();
        other.flush();
        self.push_text(&other.prefix);
        self.total = self
            .total
            .saturating_add(other.total.saturating_sub(other.prefix.len() as u64));
        if other.total >= HALF_OUTPUT_BYTES as u64 {
            self.tail = other.tail;
        }
        self.prefix_full |= other.total > other.prefix.len() as u64;
        self.decoding_error |= other.decoding_error;
    }

    /// Finalizes a small head/tail preview and writes a capped artifact on a filesystem worker.
    /// Artifacts retain existing path sanitation and explicitly disclose any discarded suffix.
    pub(crate) async fn finish(
        mut self,
        session_dir: Option<&std::path::Path>,
        tool_call_id: Option<&str>,
    ) -> String {
        self.flush();
        if self.total <= MAX_OUTPUT_BYTES as u64 {
            return self.prefix;
        }
        let head = self.prefix[..utf8_floor(&self.prefix, HALF_OUTPUT_BYTES)].to_owned();
        let mut hint = " - use smaller commands to read selectively".to_owned();
        if let (Some(directory), Some(id)) = (session_dir, tool_call_id) {
            let directory = directory.to_owned();
            let id = id.to_owned();
            let retained = self.prefix.len();
            let mut content = std::mem::take(&mut self.prefix);
            if self.total > retained as u64 {
                content.push_str(&format!(
                    "\n[Artifact truncated: retained first {retained} of {} bytes; limit {} bytes.]\n",
                    self.total, self.limit
                ));
            }
            if let Ok(Some(path)) = crate::fs::run_local_io(move || {
                Ok(crate::ai::brain::save_artifact(&directory, &id, &content))
            })
            .await
            {
                hint = format!(" - if you need more details you can see {path}");
                if self.total > retained as u64 {
                    hint.push_str(" (artifact also truncated)");
                }
            }
        }
        format!(
            "{head}\n\n[truncated: output was {} bytes{hint}]\n\n{}",
            self.total, self.tail
        )
    }
}

/// Finds a valid UTF-8 boundary without including characters beyond a byte budget.
fn utf8_floor(text: &str, mut position: usize) -> usize {
    while !text.is_char_boundary(position) {
        position -= 1;
    }
    position
}

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
    let invokes_rm = tokens
        .iter()
        .any(|token| *token == "rm" || token.ends_with("/rm"));
    let has_recursive = tokens.iter().any(|token| {
        token.starts_with('-')
            && (token.chars().skip(1).any(|c| c == 'r')
                || token == &"--recursive"
                || token.contains("recursive"))
    });
    let has_force = tokens.iter().any(|token| {
        token.starts_with('-')
            && (token.chars().skip(1).any(|c| c == 'f')
                || token == &"--force"
                || token.contains("force"))
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
    // Block actual parent-directory traversal components.
    // Catches: ../../etc/passwd, /tmp/../etc/shadow, ./../../root, etc.
    // Allows legitimate filenames like `config..bak`.
    let has_parent_traversal = std::path::Path::new(trimmed)
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir));
    if has_parent_traversal {
        return Err("Path traversal sequences ('..') are not allowed.".into());
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

/// Formats already-bounded messages using the same preview and artifact policy as streamed output.
pub(crate) async fn cap_output(
    session_dir: Option<&std::path::Path>,
    tool_call_id: Option<&str>,
    output: String,
) -> String {
    let mut capture = OutputCapture::new(MAX_ARTIFACT_BYTES);
    capture.push(0, output.as_bytes());
    capture.finish(session_dir, tool_call_id).await
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
        assert!(validate_path("/var/log/syslog").is_ok());
        assert!(validate_path("/tmp/config..bak").is_ok());
        assert!(validate_path("/").is_err());
        assert!(validate_path("..").is_err());
        assert!(validate_path("../../etc/passwd").is_err());
        assert!(validate_path("/tmp/../etc/shadow").is_err());
        assert!(validate_path("./../../root").is_err());
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

    #[tokio::test]
    async fn caps_large_output_with_head_and_tail() {
        let long = format!(
            "{}{}{}",
            "H".repeat(5000),
            "M".repeat(5000),
            "T".repeat(5000)
        );
        let capped = cap_output(None, None, long).await;
        assert!(capped.starts_with("HHHH"));
        assert!(capped.ends_with("TTTT"));
        assert!(capped.contains("[truncated"));
    }

    #[tokio::test]
    async fn preserves_short_output() {
        let short = "hello world".to_string();
        assert_eq!(cap_output(None, None, short.clone()).await, short);
    }

    #[tokio::test]
    async fn tests_saves_artifact_to_disk() {
        let tmp = std::env::temp_dir().join(format!("zync_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();

        let long = "A".repeat(10000);
        let capped = cap_output(Some(&tmp), Some("call_123"), long.clone()).await;

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

    #[tokio::test]
    async fn capture_bounds_memory_live_output_and_artifacts_while_retaining_the_tail() {
        let directory = tempfile::tempdir().unwrap();
        let mut capture = OutputCapture::new(MAX_ARTIFACT_BYTES);
        let chunk = vec![b'X'; 64 * 1024];
        let mut live = String::new();
        for _ in 0..64 {
            capture.push(0, &chunk);
            live.push_str(&capture.take_live_chunk());
            assert!(capture.prefix.len() <= MAX_ARTIFACT_BYTES);
            assert!(capture.tail.len() <= HALF_OUTPUT_BYTES);
            assert!(capture.pending.iter().all(|bytes| bytes.len() <= 3));
        }
        capture.push(1, b"final stderr diagnostic");
        live.push_str(&capture.take_live_chunk());
        assert_eq!(live.len(), MAX_OUTPUT_BYTES + LIVE_TRUNCATION_NOTICE.len());
        assert_eq!(live.matches("Live output truncated").count(), 1);
        let preview = capture
            .finish(Some(directory.path()), Some("../call_123"))
            .await;
        assert!(preview.ends_with("final stderr diagnostic"));
        assert!(preview.contains("artifact also truncated"));
        assert!(preview.len() < MAX_OUTPUT_BYTES + 512);
        let artifact =
            std::fs::read_to_string(directory.path().join("artifacts/..call_123.txt")).unwrap();
        assert!(artifact.len() <= MAX_ARTIFACT_BYTES + 256);
        assert!(artifact.contains("Artifact truncated"));
    }

    #[tokio::test]
    async fn preserves_utf8_across_chunks_and_separate_output_streams() {
        let mut capture = OutputCapture::new(MAX_OUTPUT_BYTES);
        let character = "🙂".as_bytes();
        capture.push(0, &character[..2]);
        capture.push(1, b"stderr:");
        capture.push(0, &character[2..]);
        capture.push(1, &[0xff, b':', 0xe2]);
        capture.push(1, &[0x82, 0xac]);
        assert_eq!(capture.finish(None, None).await, "stderr:🙂�:€");
    }

    #[tokio::test]
    async fn unicode_limits_never_join_text_across_discarded_prefix_bytes() {
        let mut capture = OutputCapture::new(MAX_OUTPUT_BYTES);
        capture.push(0, &vec![b'A'; MAX_OUTPUT_BYTES - 1]);
        capture.push(0, "🙂".as_bytes());
        capture.push(0, b"tail");
        assert_eq!(capture.prefix.len(), MAX_OUTPUT_BYTES - 1);
        assert!(!capture.prefix.ends_with("tail"));
        assert!(capture.complete_text().is_none());
        let preview = capture.finish(None, None).await;
        assert!(!preview.contains('�'));
        assert!(preview.ends_with("🙂tail"));
    }
}
