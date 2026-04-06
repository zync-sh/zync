/// Whether an AI provider error is transient and worth retrying.
pub(crate) fn is_retryable_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("429")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
        || lower.contains("503")
        || lower.contains("service unavailable")
        || lower.contains("502")
        || lower.contains("bad gateway")
        || lower.contains("504")
        || lower.contains("gateway timeout")
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("connection reset")
        || lower.contains("connection refused")
        || lower.contains("broken pipe")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_errors() {
        assert!(is_retryable_error("429 Too Many Requests"));
        assert!(is_retryable_error("503 Service Unavailable"));
        assert!(is_retryable_error("connection reset by peer"));
        assert!(is_retryable_error("request timed out"));
        assert!(is_retryable_error("504 Gateway Timeout"));
        assert!(is_retryable_error("gateway timeout"));
        assert!(!is_retryable_error("401 Unauthorized"));
        assert!(!is_retryable_error("Invalid API key"));
        assert!(!is_retryable_error("Unknown provider: foo"));
    }
}
