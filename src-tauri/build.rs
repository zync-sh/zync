use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    vendor_windows_conpty();
    println!("cargo:rerun-if-changed=.env");
    // Rebuild window/taskbar icons when generated icon assets change.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-env-changed=GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=ZYNC_PLUGIN_REGISTRY_URL");
    println!("cargo:rerun-if-env-changed=ZYNC_PLUGIN_REGISTRY_ROOT_KEY");
    println!("cargo:rerun-if-env-changed=ZYNC_PLUGIN_REGISTRY_ROOT_KEYS");
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

/// Fetch Microsoft's ConPTY redistributable so local Windows PTYs pass Sixel.
fn vendor_windows_conpty() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "windows" {
        return;
    }

    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let vendor_root = manifest_dir.join("vendor").join("conpty");
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let require_pair = profile != "debug" && profile != "test";

    if let Err(err) = ensure_conpty_pair(&vendor_root) {
        if require_pair {
            panic!("ConPTY redistributable required for Windows {profile} builds: {err}");
        }
        println!("cargo:warning=ConPTY sideload skipped: {err}");
        return;
    }

    let arch = conpty_arch_name();
    let pair_dir = vendor_root.join(arch);
    if !pair_dir.join("conpty.dll").is_file() || !pair_dir.join("OpenConsole.exe").is_file() {
        if require_pair {
            panic!(
                "ConPTY pair missing for {arch} at {} (needed by tauri.windows.conf.json)",
                pair_dir.display()
            );
        }
        println!("cargo:warning=ConPTY pair missing for {arch}; local Sixel may be stripped");
        return;
    }
    println!("cargo:rustc-env=ZYNC_CONPTY_DIR={}", pair_dir.display());
    println!(
        "cargo:rerun-if-changed={}",
        pair_dir.join("conpty.dll").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        pair_dir.join("OpenConsole.exe").display()
    );

    if let Err(err) = copy_conpty_next_to_profile_exe(&pair_dir) {
        if require_pair {
            panic!("Could not copy ConPTY next to {profile} exe: {err}");
        }
        println!("cargo:warning=Could not copy ConPTY next to debug/release exe: {err}");
    }
}

fn conpty_arch_name() -> &'static str {
    match std::env::var("CARGO_CFG_TARGET_ARCH")
        .unwrap_or_default()
        .as_str()
    {
        "aarch64" => "arm64",
        _ => "x64",
    }
}

const CONPTY_NUPKG_VERSION: &str = "1.24.260710001";
const CONPTY_NUPKG_SHA256: &str =
    "175640566a3b59c4b132070ee96c2c77e5ab7edd2e92732a5eb3610bbf63d90e";
const CONPTY_PROVENANCE_FILE: &str = ".nupkg-sha256";

fn conpty_pair_matches_pin(dir: &Path) -> bool {
    let dll = dir.join("conpty.dll");
    let exe = dir.join("OpenConsole.exe");
    let pin = dir.join(CONPTY_PROVENANCE_FILE);
    if !dll.is_file() || !exe.is_file() || !pin.is_file() {
        return false;
    }
    fs::read_to_string(&pin)
        .map(|s| s.trim().eq_ignore_ascii_case(CONPTY_NUPKG_SHA256))
        .unwrap_or(false)
}

fn write_conpty_provenance(dir: &Path) -> Result<(), String> {
    fs::write(dir.join(CONPTY_PROVENANCE_FILE), CONPTY_NUPKG_SHA256)
        .map_err(|e| format!("write ConPTY provenance: {e}"))
}

fn ensure_conpty_pair(vendor_root: &Path) -> Result<(), String> {
    for arch in ["x64", "arm64"] {
        let dir = vendor_root.join(arch);
        if conpty_pair_matches_pin(&dir) {
            continue;
        }
        extract_conpty_arch(vendor_root, arch)?;
        write_conpty_provenance(&dir)?;
    }
    Ok(())
}

fn extract_conpty_arch(vendor_root: &Path, arch: &str) -> Result<(), String> {
    let nupkg = fetch_conpty_nupkg(vendor_root)?;
    let file = fs::File::open(&nupkg).map_err(|e| format!("open nupkg: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip nupkg: {e}"))?;
    let (dll_name, exe_name) = match arch {
        "arm64" => (
            "runtimes/win-arm64/native/conpty.dll",
            "build/native/runtimes/arm64/OpenConsole.exe",
        ),
        _ => (
            "runtimes/win-x64/native/conpty.dll",
            "build/native/runtimes/x64/OpenConsole.exe",
        ),
    };
    let dest_dir = vendor_root.join(arch);
    fs::create_dir_all(&dest_dir).map_err(|e| format!("mkdir {}: {e}", dest_dir.display()))?;
    extract_zip_file(&mut archive, dll_name, &dest_dir.join("conpty.dll"))?;
    extract_zip_file(&mut archive, exe_name, &dest_dir.join("OpenConsole.exe"))?;
    Ok(())
}

fn fetch_conpty_nupkg(vendor_root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(vendor_root).map_err(|e| format!("mkdir vendor/conpty: {e}"))?;
    let nupkg = vendor_root.join(format!(
        "Microsoft.Windows.Console.ConPTY.{CONPTY_NUPKG_VERSION}.nupkg"
    ));
    if nupkg.is_file() && sha256_file(&nupkg)? == CONPTY_NUPKG_SHA256 {
        return Ok(nupkg);
    }

    let url = format!(
        "https://www.nuget.org/api/v2/package/Microsoft.Windows.Console.ConPTY/{CONPTY_NUPKG_VERSION}"
    );
    let status = Command::new("curl")
        .args(["-L", "--fail", "--retry", "3", "-o"])
        .arg(&nupkg)
        .arg(&url)
        .status()
        .map_err(|e| format!("curl ConPTY nupkg: {e}"))?;
    if !status.success() {
        return Err(format!("curl ConPTY nupkg exited {status}"));
    }
    let hash = sha256_file(&nupkg)?;
    if hash != CONPTY_NUPKG_SHA256 {
        let _ = fs::remove_file(&nupkg);
        return Err(format!("ConPTY nupkg hash mismatch: {hash}"));
    }
    Ok(nupkg)
}

fn extract_zip_file(
    archive: &mut zip::ZipArchive<fs::File>,
    name: &str,
    dest: &Path,
) -> Result<(), String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|e| format!("nupkg missing {name}: {e}"))?;
    let mut out = fs::File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    io::copy(&mut entry, &mut out).map_err(|e| format!("extract {name}: {e}"))?;
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn copy_conpty_next_to_profile_exe(pair_dir: &Path) -> Result<(), String> {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").map_err(|e| e.to_string())?);
    let profile_dir = out_dir
        .ancestors()
        .nth(3)
        .ok_or_else(|| "cannot resolve profile dir from OUT_DIR".to_string())?;
    for name in ["conpty.dll", "OpenConsole.exe"] {
        fs::copy(pair_dir.join(name), profile_dir.join(name))
            .map_err(|e| format!("copy {name} to {}: {e}", profile_dir.display()))?;
    }
    Ok(())
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
    !mid.is_empty()
        && mid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
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
