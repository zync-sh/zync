//! Sideload Windows Terminal's ConPTY so Sixel/DCS reaches xterm.
//!
//! In-box conhost (kernel32 `CreatePseudoConsole`) drops Sixel. `portable-pty`
//! loads `conpty.dll` when that module is already in the process, then uses
//! `OpenConsole.exe` from the same directory.

use std::path::{Path, PathBuf};

pub fn conpty_arch_dir() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

pub fn conpty_search_dirs() -> Vec<PathBuf> {
    let arch = conpty_arch_dir();
    let mut dirs = Vec::new();

    if let Some(baked) = option_env!("ZYNC_CONPTY_DIR") {
        if !baked.is_empty() {
            dirs.push(PathBuf::from(baked));
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            dirs.push(exe_dir.to_path_buf());
            dirs.push(exe_dir.join("conpty").join(arch));
            dirs.push(exe_dir.join("resources").join("conpty").join(arch));
            dirs.push(
                exe_dir
                    .join("resources")
                    .join("vendor")
                    .join("conpty")
                    .join(arch),
            );
            dirs.push(exe_dir.join("vendor").join("conpty").join(arch));
        }
    }

    dirs
}

pub fn find_conpty_dir() -> Option<PathBuf> {
    conpty_search_dirs()
        .into_iter()
        .find(|dir| dir.join("conpty.dll").is_file() && dir.join("OpenConsole.exe").is_file())
}

/// Load `conpty.dll` from the vendor pair before the first local PTY spawn.
pub fn preload_sideloaded_conpty() {
    match find_conpty_dir() {
        Some(dir) => {
            if let Err(err) = load_library(&dir.join("conpty.dll")) {
                log::warn!(
                    "[pty] failed to sideload ConPTY from {}: {err}",
                    dir.display()
                );
            }
        }
        None => {
            log::warn!(
                "[pty] bundled ConPTY not found; in-box conhost may strip Sixel on local shells"
            );
        }
    }
}

fn load_library(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryW(lp_file_name: *const u16) -> *mut std::ffi::c_void;
    }

    let handle = unsafe { LoadLibraryW(wide.as_ptr()) };
    if handle.is_null() {
        return Err(format!("{}", std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arch_dir_matches_target() {
        if cfg!(target_arch = "aarch64") {
            assert_eq!(conpty_arch_dir(), "arm64");
        } else {
            assert_eq!(conpty_arch_dir(), "x64");
        }
    }

    #[test]
    fn search_dirs_include_exe_and_resources() {
        let dirs = conpty_search_dirs();
        assert!(!dirs.is_empty());
        let rendered: Vec<String> = dirs
            .iter()
            .map(|d| d.to_string_lossy().replace('\\', "/"))
            .collect();
        assert!(
            rendered.iter().any(|d| d.contains("/conpty/")
                || d.ends_with("/conpty")
                || d.contains("vendor/conpty")),
            "expected a conpty vendor path, got {rendered:?}"
        );
    }
}
