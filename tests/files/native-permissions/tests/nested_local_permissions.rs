#![cfg(all(target_os = "linux", feature = "permission-runtime-tests"))]

// Run the same production adapter/tests under a nested module, as in the app.
// This catches child test filters that accidentally work only at the crate root.
#[allow(dead_code)]
#[path = "../../../../src-tauri/src/file_permissions/local.rs"]
mod local;
