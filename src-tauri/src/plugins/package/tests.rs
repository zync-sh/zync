use super::*;
use std::io::Cursor;
use std::path::PathBuf;
use zip::write::SimpleFileOptions;

fn archive(entries: &[(&str, &[u8])]) -> zip::ZipArchive<Cursor<Vec<u8>>> {
    let mut buffer = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        for (name, content) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .expect("start zip entry");
            writer.write_all(content).expect("write zip entry");
        }
        writer.finish().expect("finish zip");
    }
    buffer.set_position(0);
    zip::ZipArchive::new(buffer).expect("open test archive")
}

fn test_directory(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "zync-plugin-package-{label}-{}",
        uuid::Uuid::new_v4().simple()
    ))
}

#[test]
fn extracts_a_small_package() {
    let mut archive = archive(&[
        ("manifest.json", br#"{"id":"dev.example.test"}"#),
        ("dist/worker.js", b"self.ready = true;"),
    ]);
    let destination = test_directory("extract");
    fs::create_dir_all(&destination).expect("create destination");
    extract_archive(&mut archive, &destination).expect("extract package");
    assert!(destination.join("dist/worker.js").is_file());
    fs::remove_dir_all(destination).expect("remove destination");
}

#[test]
fn rejects_absolute_and_parent_archive_entries() {
    for path in ["/outside.js", "../outside.js", "dist/../../outside.js"] {
        let mut archive = archive(&[(path, b"malicious")]);
        let destination = test_directory("archive-escape");
        fs::create_dir_all(&destination).expect("create destination");
        let error = extract_archive(&mut archive, &destination)
            .expect_err("escaping archive entry must fail");
        assert!(error.to_string().contains("Invalid plugin archive path"));
        assert!(!destination.join("outside.js").exists());
        fs::remove_dir_all(destination).expect("remove destination");
    }
}

#[test]
fn rejects_extreme_compression_ratios_before_extraction() {
    let mut buffer = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer
            .start_file("worker.js", options)
            .expect("start compressed entry");
        writer
            .write_all(&vec![0; 2 * 1024 * 1024])
            .expect("write compressed payload");
        writer.finish().expect("finish zip");
    }
    buffer.set_position(0);
    let mut archive = zip::ZipArchive::new(buffer).expect("open compressed archive");
    let destination = test_directory("compression-ratio");
    fs::create_dir_all(&destination).expect("create destination");

    let error = extract_archive(&mut archive, &destination)
        .expect_err("extreme compression ratio must fail");
    assert!(error.to_string().contains("unsafe compression ratio"));
    assert!(!destination.join("worker.js").exists());
    fs::remove_dir_all(destination).expect("remove destination");
}

#[test]
fn rejects_archives_with_too_many_entries_before_extraction() {
    let mut buffer = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut buffer);
        for index in 0..=MAX_PACKAGE_ENTRIES {
            writer
                .start_file(format!("files/{index}.txt"), SimpleFileOptions::default())
                .expect("start zip entry");
        }
        writer.finish().expect("finish zip");
    }
    buffer.set_position(0);
    let mut archive = zip::ZipArchive::new(buffer).expect("open large archive");
    let destination = test_directory("too-many-entries");
    fs::create_dir_all(&destination).expect("create destination");

    let error =
        extract_archive(&mut archive, &destination).expect_err("entry-count bomb must fail");
    assert!(error.to_string().contains("more than"));
    assert_eq!(
        fs::read_dir(&destination)
            .expect("list destination")
            .count(),
        0
    );
    fs::remove_dir_all(destination).expect("remove destination");
}

#[test]
fn rejects_case_only_duplicate_paths() {
    let mut archive = archive(&[("dist/worker.js", b"a"), ("DIST/worker.js", b"b")]);
    let destination = test_directory("duplicate");
    fs::create_dir_all(&destination).expect("create destination");
    let error = extract_archive(&mut archive, &destination).expect_err("duplicates must fail");
    assert!(error.to_string().contains("duplicate path"));
    fs::remove_dir_all(destination).expect("remove destination");
}

#[test]
fn rejects_platform_ambiguous_package_paths() {
    for path in [
        "CON",
        "con.txt",
        "dist/COM1.js",
        "dist/lpt9",
        "worker.js:secret",
        "dist/worker.js.",
        "dist//worker.js",
        "dist/../worker.js",
        "C:/outside.js",
        "dist\\worker.js",
        "dist/control\u{0000}.js",
    ] {
        let error = validate_package_path(path).expect_err("ambiguous path must fail");
        assert!(
            error.to_string().contains("Invalid plugin package path"),
            "unexpected error for {path}: {error}"
        );
    }
}

#[test]
fn accepts_portable_package_paths() {
    for path in [
        "manifest.json",
        "dist/worker.js",
        "assets/icon.dark@2x.png",
        "ui/counter.html",
    ] {
        validate_package_path(path).expect("portable package path");
    }
}

#[test]
fn activation_restores_previous_version_when_staged_package_is_missing() {
    let root = test_directory("rollback");
    let target = root.join("active");
    let missing_stage = root.join("missing");
    fs::create_dir_all(&target).expect("create active package");
    fs::write(target.join("version.txt"), "old").expect("write active package");

    activate_staged_package(&target, &missing_stage).expect_err("activation must fail");
    assert_eq!(
        fs::read_to_string(target.join("version.txt")).expect("read restored package"),
        "old"
    );
    fs::remove_dir_all(root).expect("remove test root");
}

#[test]
fn pending_activation_can_restore_the_previous_package_after_runtime_failure() {
    let root = test_directory("runtime-rollback");
    let target = root.join("active");
    let staged = root.join("staged");
    let backup = root.join("backup");
    fs::create_dir_all(&target).expect("create active package");
    fs::create_dir_all(&staged).expect("create staged package");
    fs::write(target.join("version.txt"), "old").expect("write old package");
    fs::write(staged.join("version.txt"), "new").expect("write new package");

    let activation =
        begin_staged_package_activation(&target, &staged, &backup).expect("begin activation");
    assert!(activation.had_previous());
    assert_eq!(
        fs::read_to_string(target.join("version.txt")).expect("read active package"),
        "new"
    );

    activation.rollback().expect("roll back activation");
    assert_eq!(
        fs::read_to_string(target.join("version.txt")).expect("read restored package"),
        "old"
    );
    assert!(!backup.exists());
    fs::remove_dir_all(root).expect("remove test root");
}

#[test]
fn pending_first_install_is_removed_after_runtime_failure() {
    let root = test_directory("first-install-rollback");
    let target = root.join("active");
    let staged = root.join("staged");
    let backup = root.join("backup");
    fs::create_dir_all(&staged).expect("create staged package");
    fs::write(staged.join("version.txt"), "new").expect("write new package");

    let activation =
        begin_staged_package_activation(&target, &staged, &backup).expect("begin activation");
    assert!(!activation.had_previous());
    activation.rollback().expect("roll back activation");
    assert!(!target.exists());
    fs::remove_dir_all(root).expect("remove test root");
}

#[test]
fn committing_a_healthy_activation_discards_the_rollback_copy() {
    let root = test_directory("runtime-commit");
    let target = root.join("active");
    let staged = root.join("staged");
    let backup = root.join("backup");
    fs::create_dir_all(&target).expect("create active package");
    fs::create_dir_all(&staged).expect("create staged package");
    fs::write(target.join("version.txt"), "old").expect("write old package");
    fs::write(staged.join("version.txt"), "new").expect("write new package");

    begin_staged_package_activation(&target, &staged, &backup)
        .expect("begin activation")
        .commit()
        .expect("commit activation");

    assert!(!backup.exists());
    assert_eq!(
        fs::read_to_string(target.join("version.txt")).expect("read active package"),
        "new"
    );
    fs::remove_dir_all(root).expect("remove test root");
}

#[test]
fn rejects_an_oversized_manifest_file_before_reading_it() {
    let root = test_directory("large-manifest");
    fs::create_dir_all(&root).expect("create test root");
    let manifest = root.join("manifest.json");
    fs::write(&manifest, vec![b' '; MAX_MANIFEST_BYTES as usize + 1])
        .expect("write large manifest");

    let error = read_manifest_file(&manifest).expect_err("large manifest must fail");
    assert!(error.to_string().contains("exceeds 256 KiB"));
    fs::remove_dir_all(root).expect("remove test root");
}

#[test]
fn package_digest_is_stable_and_changes_with_content() {
    let first = test_directory("digest-first");
    let second = test_directory("digest-second");
    fs::create_dir_all(first.join("dist")).expect("create first package");
    fs::create_dir_all(second.join("dist")).expect("create second package");
    fs::write(first.join("manifest.json"), "manifest").expect("write first manifest");
    fs::write(first.join("dist/worker.js"), "worker-v1").expect("write first worker");
    fs::write(second.join("dist/worker.js"), "worker-v1").expect("write second worker");
    fs::write(second.join("manifest.json"), "manifest").expect("write second manifest");

    let first_digest = digest_directory(&first).expect("digest first package");
    assert_eq!(
        first_digest,
        digest_directory(&second).expect("digest second package")
    );

    fs::write(second.join("dist/worker.js"), "worker-v2").expect("change second worker");
    assert_ne!(
        first_digest,
        digest_directory(&second).expect("digest changed package")
    );
    fs::remove_dir_all(first).expect("remove first package");
    fs::remove_dir_all(second).expect("remove second package");
}

#[test]
fn package_digest_rejects_a_file_that_grew_beyond_install_limits() {
    let root = test_directory("digest-oversized-file");
    fs::create_dir_all(&root).expect("create package");
    let oversized = fs::File::create(root.join("worker.js")).expect("create package file");
    oversized
        .set_len(MAX_PACKAGE_FILE_BYTES + 1)
        .expect("grow package file");

    let error = digest_directory(&root).expect_err("oversized package file must fail");
    assert!(error.to_string().contains("exceeds 20 MiB"));
    fs::remove_dir_all(root).expect("remove package");
}

#[test]
fn package_digest_streams_files_without_changing_the_stable_digest() {
    let first = test_directory("digest-stream-first");
    let second = test_directory("digest-stream-second");
    fs::create_dir_all(&first).expect("create first package");
    fs::create_dir_all(&second).expect("create second package");
    let content = vec![b'z'; 2 * 1024 * 1024];
    fs::write(first.join("worker.js"), &content).expect("write first package");
    fs::write(second.join("worker.js"), &content).expect("write second package");

    assert_eq!(
        digest_directory(&first).expect("digest first package"),
        digest_directory(&second).expect("digest second package")
    );
    fs::remove_dir_all(first).expect("remove first package");
    fs::remove_dir_all(second).expect("remove second package");
}
