//! Windows pipe ownership and offline Authenticode inspection. No process enumeration or shell tools.

use super::{signed_provider, AgentOrigin, AgentProvider};
use std::{
    ffi::OsString,
    os::windows::{
        ffi::OsStringExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
};
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE},
    Security::{
        Cryptography::{CertGetNameStringW, CERT_NAME_SIMPLE_DISPLAY_TYPE},
        WinTrust::*,
    },
    System::{
        Pipes::GetNamedPipeServerProcessId,
        Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION},
    },
};

/// Inspect only the server process of the already-open pipe. Access failures stay anonymous.
pub(super) fn origin(pipe: &tokio::net::windows::named_pipe::NamedPipeClient) -> AgentOrigin {
    let image = (|| {
        let mut process_id = 0;
        // SAFETY: the borrowed pipe handle stays alive during this synchronous call.
        if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle() as HANDLE, &mut process_id) }
            == 0
        {
            return None;
        }
        // SAFETY: query-only access; OwnedHandle below closes the successful result exactly once.
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if raw.is_null() {
            return None;
        }
        let process = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut path = vec![0u16; 32768];
        let mut length = path.len() as u32;
        // SAFETY: path is initialized and length describes its allocated capacity.
        if unsafe {
            QueryFullProcessImageNameW(
                process.as_raw_handle() as HANDLE,
                0,
                path.as_mut_ptr(),
                &mut length,
            )
        } == 0
        {
            return None;
        }
        Some(OsString::from_wide(path.get(..length as usize)?).into())
    })();
    AgentOrigin::WindowsProcess(image)
}

/// Close WinTrust state on success, rejection and every subsequent early return.
struct TrustState(WINTRUST_DATA);
impl Drop for TrustState {
    fn drop(&mut self) {
        self.0.dwStateAction = WTD_STATEACTION_CLOSE;
        let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        // SAFETY: this is the same state and action used for verification; no UI is allowed.
        unsafe {
            WinVerifyTrust(
                INVALID_HANDLE_VALUE,
                &mut action,
                (&mut self.0 as *mut WINTRUST_DATA).cast(),
            );
        }
    }
}

/// The badge is display metadata, not an authorization decision. Offline checks never fetch certificates.
pub(super) fn identify(path: &Path) -> Option<AgentProvider> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: wide.as_ptr(),
        ..Default::default()
    };
    let mut state = TrustState(WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL,
        ..Default::default()
    });
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // SAFETY: wide and file outlive state; all pointers returned below are borrowed until state closes.
    unsafe {
        if WinVerifyTrust(
            INVALID_HANDLE_VALUE,
            &mut action,
            (&mut state.0 as *mut WINTRUST_DATA).cast(),
        ) != 0
        {
            return None;
        }
        let data = WTHelperProvDataFromStateData(state.0.hWVTStateData);
        if data.is_null() {
            return None;
        }
        let signer = WTHelperGetProvSignerFromChain(data, 0, 0, 0);
        if signer.is_null() || (*signer).csCertChain == 0 || (*signer).pasCertChain.is_null() {
            return None;
        }
        let certificate = (*(*signer).pasCertChain).pCert;
        if certificate.is_null() {
            return None;
        }
        let count = CertGetNameStringW(
            certificate,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
        );
        if count <= 1 {
            return None;
        }
        let mut name = vec![0u16; count as usize];
        if CertGetNameStringW(
            certificate,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            std::ptr::null(),
            name.as_mut_ptr(),
            count,
        ) != count
        {
            return None;
        }
        let publisher = String::from_utf16(name.get(..count as usize - 1)?).ok()?;
        signed_provider(path.file_name()?.to_str()?, &publisher, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_and_unsigned_files_do_not_get_a_provider() {
        let folder = tempfile::tempdir().unwrap();
        let executable = folder.path().join("Bitwarden.exe");
        assert!(identify(&executable).is_none());
        std::fs::write(&executable, b"not a signed executable").unwrap();
        assert!(identify(&executable).is_none());
    }
}
