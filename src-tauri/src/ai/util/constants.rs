use std::time::Duration;

/// Maximum time a single agent tool command is allowed to run.
pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
