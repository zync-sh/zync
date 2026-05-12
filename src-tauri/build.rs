fn main() {
    println!("cargo:rerun-if-changed=.env");
    println!("cargo:rerun-if-env-changed=GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=PROFILE");
    let mut file_google_client_id: Option<String> = None;
    if let Ok(contents) = std::fs::read_to_string(".env") {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let line = if let Some(stripped) = line.strip_prefix("export ") {
                stripped.trim_start()
            } else {
                line
            };
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                if should_skip_rustc_env(key) {
                    continue;
                }
                let cleaned_value = clean_env_value(value.trim());
                if key.eq_ignore_ascii_case("GOOGLE_CLIENT_ID") {
                    file_google_client_id = Some(cleaned_value.clone());
                }
                emit_rustc_env(key, &cleaned_value);
            }
        }
    }
    // Require a real Google client ID for any non-debug, non-test build.
    let profile = std::env::var("PROFILE").ok();
    let profile_str = profile.as_deref().unwrap_or("");
    if profile_str != "debug" && profile_str != "test" {
        let env_google_client_id = std::env::var("GOOGLE_CLIENT_ID").ok();
        let has_valid_client_id = file_google_client_id
            .as_deref()
            .or(env_google_client_id.as_deref())
            .map(is_valid_google_client_id)
            .unwrap_or(false);
        if !has_valid_client_id {
            panic!("GOOGLE_CLIENT_ID is missing or placeholder. Set a real client ID for release builds.");
        }
    }
    tauri_build::build()
}

fn should_skip_rustc_env(key: &str) -> bool {
    // GOOGLE_CLIENT_SECRET is intentionally allowlisted here for compatibility
    // with user-configured OAuth clients that still require it in the token
    // exchange request body.
    //
    // IMPORTANT: For Google's installed-app / desktop OAuth flow, the client
    // secret is NOT confidential — Google's own documentation states it cannot
    // be kept secret in a distributed desktop application. It must never be
    // treated as a server-side secret or used for server-side authentication.
    // It is effectively a public identifier, similar to the client ID.
    //
    // TODO: Migrate to a pure PKCE-only OAuth client (no client_secret) once
    // the Google Cloud project is updated to use a client type that does not
    // require a secret. At that point, remove this allowlist entry and delete
    // the GOOGLE_CLIENT_SECRET env var entirely.
    if key.eq_ignore_ascii_case("GOOGLE_CLIENT_SECRET") {
        return false;
    }

    is_sensitive_env_key(key)
}

fn is_sensitive_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper == "SECRET"
        || upper.ends_with("_SECRET")
        || upper == "PASSWORD"
        || upper.ends_with("_PASSWORD")
        || upper == "TOKEN"
        || upper.ends_with("_TOKEN")
        || upper == "API_KEY"
        || upper.ends_with("_API_KEY")
        || upper == "CREDENTIAL"
        || upper == "CREDENTIALS"
        || upper.ends_with("_CREDENTIAL")
        || upper.ends_with("_CREDENTIALS")
        || upper.contains("PRIVATE_KEY")
        || upper.ends_with("_PRIVATE")
        || upper.contains("AUTH_TOKEN")
        || upper.contains("AUTH_KEY")
}

fn emit_rustc_env(key: &str, value: &str) {
    // Escape backslashes first so pre-existing sequences like "\\n" are not
    // confused with the newline escape we add in the next step.
    let single_line = value
        .replace('\\', "\\\\")
        .replace('\r', "\\r")
        .replace('\n', "\\n");
    println!("cargo:rustc-env={}={}", key, single_line);
}

fn is_valid_google_client_id(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "PLACEHOLDER_CLIENT_ID" {
        return false;
    }
    // Google OAuth installed-app client IDs follow the pattern:
    //   <digits>-<alphanumeric/underscore/dash>.apps.googleusercontent.com
    // Validate this shape to catch obviously wrong values early.
    let Some((prefix, suffix)) = trimmed.split_once('-') else {
        return false;
    };
    if prefix.is_empty() || !prefix.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let Some(mid) = suffix.strip_suffix(".apps.googleusercontent.com") else {
        return false;
    };
    !mid.is_empty() && mid.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn clean_env_value(value: &str) -> String {
    let unquoted = if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    };

    decode_escapes(unquoted)
}

fn decode_escapes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();

    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('"') => out.push('"'),
            Some('\'') => out.push('\''),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }

    out
}
