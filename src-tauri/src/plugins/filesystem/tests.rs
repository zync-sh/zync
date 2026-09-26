use super::path_policy::{validate_file_name, validate_relative_path};
use super::*;

#[test]
fn relative_paths_reject_escape_devices_and_alternate_streams() {
    assert!(validate_relative_path("notes/today.txt").is_ok());
    assert!(validate_relative_path("../secret.txt").is_err());
    assert!(validate_relative_path("/absolute.txt").is_err());
    assert!(validate_relative_path("report.txt:hidden").is_err());
    assert!(validate_relative_path("CON.txt").is_err());
    assert!(validate_file_name("notes.txt").is_ok());
    assert!(validate_file_name("report.txt:hidden").is_err());
    assert!(validate_file_name("NUL.log").is_err());
    assert!(validate_file_name("trailing. ").is_err());
}

#[test]
fn opaque_handles_are_owned_by_one_runtime() {
    let state = PluginFilesystemState::new();
    let handle = "pfh_0123456789abcdef".to_string();
    state.handles.lock().expect("handle lock").insert(
        handle.clone(),
        HandleRecord {
            runtime_instance_id: "runtime-a".into(),
            root: PathBuf::from("selected.txt"),
            kind: PluginFilesystemPickKind::File,
            access: PluginFilesystemHandleAccess::Read,
        },
    );
    assert!(state.record_for("runtime-a", &handle).is_ok());
    assert!(state.record_for("runtime-b", &handle).is_err());
    state.revoke_runtime("runtime-a");
    assert!(state.record_for("runtime-a", &handle).is_err());
}

#[test]
fn folder_handles_resolve_only_existing_descendants() {
    let root = std::env::temp_dir().join(format!(
        "zync-plugin-filesystem-resolve-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(root.join("notes")).expect("create selected folder");
    fs::write(root.join("notes/today.txt"), "safe").expect("write selected file");
    let canonical_root = fs::canonicalize(&root).expect("canonical selected folder");
    let record = HandleRecord {
        runtime_instance_id: "runtime-a".into(),
        root: canonical_root.clone(),
        kind: PluginFilesystemPickKind::Directory,
        access: PluginFilesystemHandleAccess::Read,
    };

    assert_eq!(
        resolve_target(&record, Some("notes/today.txt")).expect("resolve child"),
        fs::canonicalize(root.join("notes/today.txt")).expect("canonical child")
    );
    assert!(resolve_target(&record, Some("../outside.txt")).is_err());
    assert!(resolve_target(&record, Some("missing.txt")).is_err());
    fs::remove_dir_all(root).expect("remove test folder");
}

#[test]
fn hard_link_detection_prevents_alias_reads() {
    let root = std::env::temp_dir().join(format!(
        "zync-plugin-filesystem-links-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).expect("create link test folder");
    let original = root.join("original.txt");
    let alias = root.join("alias.txt");
    fs::write(&original, "secret").expect("write link target");
    fs::hard_link(&original, &alias).expect("create hard link");
    let metadata = fs::metadata(&alias).expect("inspect hard link");
    assert!(has_multiple_hard_links(&alias, &metadata).expect("count hard links"));
    fs::remove_dir_all(root).expect("remove link test folder");
}

#[test]
fn handles_do_not_gain_read_or_write_authority() {
    let read = HandleRecord {
        runtime_instance_id: "runtime-a".into(),
        root: PathBuf::from("read.txt"),
        kind: PluginFilesystemPickKind::File,
        access: PluginFilesystemHandleAccess::Read,
    };
    let write = HandleRecord {
        runtime_instance_id: "runtime-a".into(),
        root: PathBuf::from("write.txt"),
        kind: PluginFilesystemPickKind::File,
        access: PluginFilesystemHandleAccess::Write,
    };
    assert!(require_access(&read, PluginFilesystemHandleAccess::Read).is_ok());
    assert!(require_access(&read, PluginFilesystemHandleAccess::Write).is_err());
    assert!(require_access(&write, PluginFilesystemHandleAccess::Write).is_ok());
    assert!(require_access(&write, PluginFilesystemHandleAccess::Read).is_err());
}

#[test]
fn external_atomic_write_does_not_touch_user_backup_files() {
    let root = std::env::temp_dir().join(format!(
        "zync-plugin-filesystem-write-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).expect("create write test folder");
    let target = root.join("notes.txt");
    let user_backup = root.join("notes.bak");
    fs::write(&target, "old").expect("seed target");
    fs::write(&user_backup, "keep me").expect("seed user backup");

    atomic_replace_external(&target, b"new").expect("replace external file");

    assert_eq!(fs::read_to_string(&target).expect("read target"), "new");
    assert_eq!(
        fs::read_to_string(&user_backup).expect("read user backup"),
        "keep me"
    );
    assert_eq!(
        fs::read_dir(&root)
            .expect("list write folder")
            .filter_map(|entry| entry.ok())
            .count(),
        2
    );
    fs::remove_dir_all(root).expect("remove write test folder");
}
