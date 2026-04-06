use regex::Regex;
use std::sync::LazyLock;

/// Whether an AI provider error is transient and worth retrying.
pub(crate) fn is_retryable_error(err: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)\b(429|502|503|504)\b|rate limit|too many requests|service unavailable|bad gateway|gateway timeout|connection (reset|refused)|broken pipe|\btimeout\b|\btimed out\b"
        ).unwrap()
    });

    RE.is_match(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_errors() {
        // Positive cases
        assert!(is_retryable_error("429 Too Many Requests"));
        assert!(is_retryable_error("503 Service Unavailable"));
        assert!(is_retryable_error("connection reset by peer"));
        assert!(is_retryable_error("request timed out"));
        assert!(is_retryable_error("504 Gateway Timeout"));
        assert!(is_retryable_error("gateway timeout"));
        assert!(is_retryable_error("Error 502: Bad Gateway"));
        
        // Negative cases (precision)
        assert!(!is_retryable_error("error429occured")); // No word boundary
        assert!(!is_retryable_error("4293 error code")); // Numeric suffix
        assert!(!is_retryable_error("401 Unauthorized"));
        assert!(!is_retryable_error("Invalid API key"));
        assert!(!is_retryable_error("Unknown provider: foo"));
        assert!(!is_retryable_error(""));
        assert!(!is_retryable_error("   "));
        assert!(!is_retryable_error("gatewaytimeout")); // Missing space if phrase-based
    }
}
