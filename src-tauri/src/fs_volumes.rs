//! Local volume enumeration for Files Places (This PC / Volumes / Other Locations).
//! Separate from `list_local`: empty path is still the home directory.

use anyhow::Result;
use serde::Serialize;
#[cfg(any(target_os = "linux", test))]
use std::collections::HashSet;

const MAX_VOLUMES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileVolumeKind {
    Fixed,
    Removable,
    Optical,
    Network,
    Linux,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVolume {
    pub id: String,
    pub path: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub letter: Option<String>,
    pub kind: FileVolumeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
}

impl FileVolume {
    fn new(path: String, label: String, kind: FileVolumeKind) -> Self {
        let id = path.clone();
        Self {
            id,
            path,
            label,
            letter: None,
            kind,
            free_bytes: None,
            total_bytes: None,
        }
    }
}

pub fn list_local_volumes() -> Result<Vec<FileVolume>> {
    let mut volumes = list_local_volumes_platform()?;
    volumes.truncate(MAX_VOLUMES);
    Ok(volumes)
}

#[cfg(windows)]
fn list_local_volumes_platform() -> Result<Vec<FileVolume>> {
    windows_volumes()
}

#[cfg(target_os = "macos")]
fn list_local_volumes_platform() -> Result<Vec<FileVolume>> {
    macos_volumes()
}

#[cfg(target_os = "linux")]
fn list_local_volumes_platform() -> Result<Vec<FileVolume>> {
    linux_volumes()
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn list_local_volumes_platform() -> Result<Vec<FileVolume>> {
    Ok(Vec::new())
}

#[cfg(windows)]
fn windows_volumes() -> Result<Vec<FileVolume>> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::ffi::OsStringExt;

    const DRIVE_UNKNOWN: u32 = 0;
    const DRIVE_NO_ROOT_DIR: u32 = 1;
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;
    const DRIVE_RAMDISK: u32 = 6;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetLogicalDriveStringsW(buffer_length: u32, buffer: *mut u16) -> u32;
        fn GetDriveTypeW(root_path_name: *const u16) -> u32;
        fn GetVolumeInformationW(
            root_path_name: *const u16,
            volume_name_buffer: *mut u16,
            volume_name_size: u32,
            volume_serial_number: *mut u32,
            maximum_component_length: *mut u32,
            file_system_flags: *mut u32,
            file_system_name_buffer: *mut u16,
            file_system_name_size: u32,
        ) -> i32;
        fn GetDiskFreeSpaceExW(
            directory_name: *const u16,
            free_bytes_available_to_caller: *mut u64,
            total_number_of_bytes: *mut u64,
            total_number_of_free_bytes: *mut u64,
        ) -> i32;
    }

    fn to_wide(path: &str) -> Vec<u16> {
        std::ffi::OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn from_wide(buf: &[u16]) -> String {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        std::ffi::OsString::from_wide(&buf[..len])
            .to_string_lossy()
            .into_owned()
    }

    let needed = unsafe { GetLogicalDriveStringsW(0, std::ptr::null_mut()) };
    if needed == 0 {
        return Ok(Vec::new());
    }
    let cap = needed.min(1024);
    let mut buf = vec![0u16; cap as usize];
    let written = unsafe { GetLogicalDriveStringsW(cap, buf.as_mut_ptr()) };
    if written == 0 {
        return Ok(Vec::new());
    }

    let mut volumes = Vec::new();
    let mut start = 0usize;
    let filled = (written as usize).min(buf.len());
    for i in 0..filled {
        if buf[i] != 0 {
            continue;
        }
        if i == start {
            break;
        }
        let root = from_wide(&buf[start..i]);
        start = i + 1;
        if root.is_empty() {
            continue;
        }
        let wide = to_wide(&root);
        let drive_type = unsafe { GetDriveTypeW(wide.as_ptr()) };
        if drive_type == DRIVE_UNKNOWN || drive_type == DRIVE_NO_ROOT_DIR {
            continue;
        }
        let kind = match drive_type {
            DRIVE_REMOVABLE => FileVolumeKind::Removable,
            DRIVE_CDROM => FileVolumeKind::Optical,
            DRIVE_REMOTE => FileVolumeKind::Network,
            DRIVE_FIXED | DRIVE_RAMDISK => FileVolumeKind::Fixed,
            _ => FileVolumeKind::Other,
        };
        let letter = root.trim_end_matches(['\\', '/']).to_string();
        let probe_label = matches!(kind, FileVolumeKind::Fixed | FileVolumeKind::Removable);
        let probe_space = matches!(kind, FileVolumeKind::Fixed);
        let mut label = String::new();
        if probe_label {
            let mut name = [0u16; 261];
            let ok = unsafe {
                GetVolumeInformationW(
                    wide.as_ptr(),
                    name.as_mut_ptr(),
                    name.len() as u32,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    0,
                )
            };
            if ok != 0 {
                label = from_wide(&name);
            }
        }
        let mut volume = FileVolume::new(root, label, kind);
        volume.letter = Some(letter);
        if probe_space {
            let mut free = 0u64;
            let mut total = 0u64;
            let ok = unsafe {
                GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, std::ptr::null_mut())
            };
            if ok != 0 {
                volume.free_bytes = Some(free);
                volume.total_bytes = Some(total);
            }
        }
        volumes.push(volume);
        if volumes.len() >= MAX_VOLUMES {
            break;
        }
    }
    volumes.sort_by(|a, b| {
        a.letter
            .as_deref()
            .unwrap_or("")
            .cmp(b.letter.as_deref().unwrap_or(""))
    });
    volumes.extend(windows_wsl_volumes());
    volumes.truncate(MAX_VOLUMES);
    Ok(volumes)
}

fn decode_wsl_list_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && (bytes[1] == 0 || (bytes[0] == 0xFF && bytes[1] == 0xFE)) {
        let mut words = Vec::with_capacity(bytes.len() / 2);
        let mut i = 0usize;
        while i + 1 < bytes.len() {
            words.push(u16::from_le_bytes([bytes[i], bytes[i + 1]]));
            i += 2;
        }
        let mut decoded = String::from_utf16_lossy(&words);
        if decoded.starts_with('\u{feff}') {
            decoded.remove(0);
        }
        return decoded;
    }
    String::from_utf8_lossy(bytes).into_owned()
}

pub fn parse_wsl_distro_names(bytes: &[u8]) -> Vec<String> {
    decode_wsl_list_output(bytes)
        .lines()
        .map(|line| line.trim().trim_start_matches('\u{feff}').to_string())
        .filter(|line| {
            !line.is_empty()
                && !line.eq_ignore_ascii_case("docker-desktop")
                && !line.eq_ignore_ascii_case("docker-desktop-data")
        })
        .collect()
}

#[cfg(windows)]
fn windows_wsl_volumes() -> Vec<FileVolume> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const TIMEOUT: Duration = Duration::from_millis(2000);
    let mut child = match Command::new("wsl.exe")
        .args(["-l", "-q"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return Vec::new(),
    };
    let mut stdout = match child.stdout.take() {
        Some(out) => out,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Vec::new();
        }
    };
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut bytes = Vec::new();
                let _ = stdout.read_to_end(&mut bytes);
                if !status.success() {
                    return Vec::new();
                }
                return parse_wsl_distro_names(&bytes)
                    .into_iter()
                    .map(|name| {
                        let path = format!("\\\\wsl.localhost\\{name}\\");
                        FileVolume {
                            id: path.clone(),
                            path,
                            label: name,
                            letter: None,
                            kind: FileVolumeKind::Linux,
                            free_bytes: None,
                            total_bytes: None,
                        }
                    })
                    .collect();
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Vec::new();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Vec::new();
            }
        }
    }
}

#[cfg(unix)]
fn device_id(path: &str) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|meta| meta.dev())
}

#[cfg(target_os = "macos")]
fn macos_volumes() -> Result<Vec<FileVolume>> {
    let root_dev = device_id("/");
    let mut system_label = String::from("Macintosh HD");
    let mut volumes = vec![FileVolume::new(
        "/".to_string(),
        system_label.clone(),
        FileVolumeKind::Fixed,
    )];
    let Ok(entries) = std::fs::read_dir("/Volumes") else {
        return Ok(volumes);
    };
    let mut extras: Vec<FileVolume> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        let path = format!("/Volumes/{name}");
        if !entry.path().is_dir() {
            continue;
        }
        if let (Some(root), Some(dev)) = (root_dev, device_id(&path)) {
            if dev == root {
                if !name.is_empty() {
                    system_label = name.into_owned();
                }
                continue;
            }
        }
        let kind = FileVolumeKind::Removable;
        extras.push(FileVolume::new(path, name.into_owned(), kind));
        if extras.len() + 1 >= MAX_VOLUMES {
            break;
        }
    }
    extras.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    if let Some(root) = volumes.first_mut() {
        root.label = system_label;
    }
    volumes.extend(extras);
    Ok(volumes)
}

#[cfg(target_os = "linux")]
fn linux_volumes() -> Result<Vec<FileVolume>> {
    let text = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    Ok(volumes_from_proc_mounts(&text))
}

#[cfg(any(target_os = "linux", test))]
pub fn unescape_mount_field(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 4 <= bytes.len() {
            let oct = std::str::from_utf8(&bytes[i + 1..i + 4])
                .ok()
                .and_then(|s| u8::from_str_radix(s, 8).ok());
            if let Some(byte) = oct {
                out.push(byte);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(any(target_os = "linux", test))]
pub fn keep_linux_fstype(fstype: &str) -> bool {
    matches!(
        fstype,
        "ext2"
            | "ext3"
            | "ext4"
            | "xfs"
            | "btrfs"
            | "f2fs"
            | "zfs"
            | "jfs"
            | "reiserfs"
            | "ntfs"
            | "ntfs3"
            | "vfat"
            | "msdos"
            | "exfat"
            | "fuseblk"
            | "fuse"
            | "fuse.ntfs"
            | "fuse.exfat"
            | "fuse.sshfs"
            | "nfs"
            | "nfs4"
            | "cifs"
            | "smb3"
            | "apfs"
            | "hfsplus"
            | "udf"
            | "iso9660"
    )
}

#[cfg(any(target_os = "linux", test))]
fn linux_kind(fstype: &str, mountpoint: &str) -> FileVolumeKind {
    if matches!(fstype, "nfs" | "nfs4" | "cifs" | "smb3" | "fuse.sshfs") {
        return FileVolumeKind::Network;
    }
    if matches!(fstype, "iso9660" | "udf") {
        return FileVolumeKind::Optical;
    }
    if mountpoint.contains("/media/") || mountpoint.contains("/run/media/") {
        return FileVolumeKind::Removable;
    }
    if matches!(fstype, "vfat" | "exfat" | "msdos") && mountpoint.starts_with("/mnt/") {
        return FileVolumeKind::Removable;
    }
    FileVolumeKind::Fixed
}

#[cfg(any(target_os = "linux", test))]
fn linux_label(mountpoint: &str) -> String {
    if mountpoint == "/" {
        return "Filesystem".to_string();
    }
    std::path::Path::new(mountpoint)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| mountpoint.to_string())
}

/// Parse `/proc/self/mounts` into user-facing volumes. Used by Linux and unit tests.
#[cfg(any(target_os = "linux", test))]
pub fn volumes_from_proc_mounts(text: &str) -> Vec<FileVolume> {
    let mut seen = HashSet::new();
    let mut volumes = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if index >= 512 {
            break;
        }
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let _source = parts.next();
        let Some(raw_mount) = parts.next() else {
            continue;
        };
        let Some(fstype) = parts.next() else {
            continue;
        };
        let mountpoint = unescape_mount_field(raw_mount);
        if mountpoint != "/" && !keep_linux_fstype(fstype) {
            continue;
        }
        if !seen.insert(mountpoint.clone()) {
            continue;
        }
        let kind = if mountpoint == "/" {
            FileVolumeKind::Fixed
        } else {
            linux_kind(fstype, &mountpoint)
        };
        volumes.push(FileVolume::new(
            mountpoint.clone(),
            linux_label(&mountpoint),
            kind,
        ));
        if volumes.len() >= MAX_VOLUMES {
            break;
        }
    }
    if !seen.contains("/") {
        volumes.insert(
            0,
            FileVolume::new(
                "/".to_string(),
                "Filesystem".to_string(),
                FileVolumeKind::Fixed,
            ),
        );
    } else {
        volumes.sort_by(
            |a, b| match (a.path.as_str() == "/", b.path.as_str() == "/") {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.path.cmp(&b.path),
            },
        );
    }
    volumes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescape_octal_spaces() {
        assert_eq!(
            unescape_mount_field("/media/me/My\\040Disk"),
            "/media/me/My Disk"
        );
        assert_eq!(unescape_mount_field("/media/end\\040"), "/media/end ");
        assert_eq!(unescape_mount_field("/media/Café"), "/media/Café");
        assert_eq!(unescape_mount_field("/media/Caf\\303\\251"), "/media/Café");
    }

    #[test]
    fn linux_skips_virtual_fs() {
        assert!(!keep_linux_fstype("proc"));
        assert!(!keep_linux_fstype("sysfs"));
        assert!(!keep_linux_fstype("tmpfs"));
        assert!(!keep_linux_fstype("squashfs"));
        assert!(!keep_linux_fstype("overlay"));
        assert!(!keep_linux_fstype("cgroup2"));
        assert!(keep_linux_fstype("ext4"));
        assert!(keep_linux_fstype("ntfs3"));
        assert!(keep_linux_fstype("cifs"));
    }

    #[test]
    fn linux_proc_mounts_keeps_root_and_usb() {
        let mounts = "\
proc /proc proc rw 0 0
sysfs /sys sysfs rw 0 0
/dev/sda1 / ext4 rw,relatime 0 0
/dev/sdb1 /media/me/USB vfat rw,nosuid 0 0
/dev/loop0 /snap/core squashfs ro 0 0
tmpfs /tmp tmpfs rw 0 0
";
        let volumes = volumes_from_proc_mounts(mounts);
        let paths: Vec<_> = volumes.iter().map(|v| v.path.as_str()).collect();
        assert_eq!(paths, vec!["/", "/media/me/USB"]);
        assert_eq!(volumes[0].label, "Filesystem");
        assert_eq!(volumes[1].label, "USB");
        assert_eq!(volumes[1].kind, FileVolumeKind::Removable);
    }

    #[test]
    fn linux_always_has_root_even_if_missing() {
        let volumes = volumes_from_proc_mounts("proc /proc proc rw 0 0\n");
        assert_eq!(volumes.len(), 1);
        assert_eq!(volumes[0].path, "/");
    }

    #[test]
    fn linux_separate_home_partition_is_listed() {
        let mounts = "\
/dev/sda1 / ext4 rw 0 0
/dev/sda2 /home ext4 rw 0 0
";
        let volumes = volumes_from_proc_mounts(mounts);
        let paths: Vec<_> = volumes.iter().map(|v| v.path.as_str()).collect();
        assert_eq!(paths, vec!["/", "/home"]);
    }

    #[test]
    fn parse_wsl_distro_names_skips_docker_helpers() {
        let utf16: Vec<u8> = "Ubuntu\r\ndocker-desktop\r\ndocker-desktop-data\r\nDebian\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(parse_wsl_distro_names(&utf16), vec!["Ubuntu", "Debian"]);
    }
}
