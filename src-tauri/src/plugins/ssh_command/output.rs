const MAX_OUTPUT: usize = 2 * 1024 * 1024;

#[derive(Default)]
pub(super) struct CommandOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    exit_code: Option<u32>,
}

impl CommandOutput {
    pub(super) fn push(&mut self, bytes: &[u8], is_stderr: bool) -> Result<(), String> {
        let remaining = MAX_OUTPUT - self.stdout.len() - self.stderr.len();
        if bytes.len() > remaining {
            return Err("Server command exceeded the 2 MiB output limit".into());
        }
        if is_stderr {
            self.stderr.extend_from_slice(bytes);
        } else {
            self.stdout.extend_from_slice(bytes);
        }
        Ok(())
    }

    pub(super) fn exit_status(&mut self, code: u32) {
        self.exit_code = Some(code);
    }

    pub(super) fn finish(self, connection_token: String) -> Result<super::CommandResult, String> {
        Ok(super::CommandResult {
            stdout: String::from_utf8_lossy(&self.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&self.stderr).into_owned(),
            exit_code: self
                .exit_code
                .ok_or("Server disconnected without a command exit status")?,
            connection_token,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combined_limit_is_checked_before_allocating() {
        let mut output = CommandOutput::default();
        output.push(&vec![b'x'; MAX_OUTPUT - 1], false).unwrap();
        output.push(b"y", true).unwrap();
        assert!(output.push(b"z", true).is_err());
        assert_eq!(output.stderr, b"y");
    }

    #[test]
    fn disconnect_is_not_success_and_nonzero_status_is_preserved() {
        assert!(CommandOutput::default().finish("token".into()).is_err());
        let mut output = CommandOutput::default();
        output.exit_status(127);
        output.push(b"pm2 not found", true).unwrap();
        let result = output.finish("token".into()).unwrap();
        assert_eq!(result.exit_code, 127);
        assert_eq!(result.stderr, "pm2 not found");
        assert_eq!(result.connection_token, "token");
    }

    #[test]
    fn multibyte_characters_can_span_channel_messages() {
        let mut output = CommandOutput::default();
        let bytes = "server ✓".as_bytes();
        output.push(&bytes[..8], false).unwrap();
        output.push(&bytes[8..], false).unwrap();
        output.exit_status(0);
        assert_eq!(output.finish("token".into()).unwrap().stdout, "server ✓");
    }
}
