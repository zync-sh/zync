fn main() {
    println!("cargo:rerun-if-changed=.env");
    let mut file_google_client_id: Option<String> = None;
    if let Ok(contents) = std::fs::read_to_string(".env") {
        for line in contents.lines() {
            let mut line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(stripped) = line.strip_prefix("export ") {
                line = stripped.trim_start();
            }
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
    if std::env::var("PROFILE").ok().as_deref() == Some("release") {
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
    // Google Drive vault sync currently uses a desktop PKCE flow that may still
    // require a client secret for some user-configured OAuth clients. Keep this
    // explicitly allowlisted so future secret-filter tightening does not break
    // local Google Drive connect again.
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
    let single_line = value
        .replace('\r', "\\r")
        .replace('\n', "\\n");
    println!("cargo:rustc-env={}={}", key, single_line);
}

fn is_valid_google_client_id(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed != "PLACEHOLDER_CLIENT_ID"
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
