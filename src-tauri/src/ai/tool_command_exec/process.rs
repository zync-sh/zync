//! Local commands own a process group/job until normal completion or cancellation.

use tokio::process::{Child, Command};

use platform::ProcessTree;

/// Retains both the direct child and its platform tree boundary until output is drained.
pub(super) struct OwnedProcess {
    child: Option<Child>,
    tree: ProcessTree,
}

impl OwnedProcess {
    /// Establishes tree ownership before user code can spawn descendants.
    pub(super) fn spawn(command: &mut Command) -> Result<Self, String> {
        command.kill_on_drop(true);
        let (child, tree) = platform::spawn(command)?;
        Ok(Self {
            child: Some(child),
            tree,
        })
    }

    /// Borrows the owned child for pipe extraction and the final wait.
    pub(super) fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("owned command child")
    }

    /// Releases tree cleanup after a normal wait, including nonzero command exit codes.
    /// Intentional background services with detached stdio retain their prior behavior.
    pub(super) fn complete(mut self) -> Result<(), String> {
        self.tree.disarm()?;
        drop(self.child.take());
        Ok(())
    }
}

impl Drop for OwnedProcess {
    /// Cancels descendants before releasing the direct-child handle to the async reaper.
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            self.tree.terminate();
            reap(child);
        }
    }
}

/// Retains child ownership while Tokio waits for termination, avoiding unreaped cancelled children.
fn reap(mut child: Child) {
    let _ = child.start_kill();
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(async move {
            let _ = child.wait().await;
        });
    }
    // Outside a runtime, kill_on_drop remains the fallback; normal app execution has a runtime.
}

#[cfg(unix)]
mod platform {
    use super::{Child, Command};

    pub(super) struct ProcessTree {
        group: libc::pid_t,
        armed: bool,
    }

    /// Creates a fresh group whose positive leader PID remains owned until the final wait.
    pub(super) fn spawn(command: &mut Command) -> Result<(Child, ProcessTree), String> {
        let child = command
            .process_group(0)
            .spawn()
            .map_err(|error| format!("Failed to spawn process: {error}"))?;
        let group = child
            .id()
            .filter(|id| *id != 0)
            .and_then(|id| libc::pid_t::try_from(id).ok());
        match group {
            Some(group) => Ok((child, ProcessTree { group, armed: true })),
            None => {
                super::reap(child);
                Err("Cannot own command process group: missing or invalid child PID".into())
            }
        }
    }

    impl ProcessTree {
        /// Signals only the dedicated positive group created for this still-owned child.
        pub(super) fn terminate(&self) {
            if self.armed {
                // SAFETY: group is a checked positive pid_t returned by our child after
                // process_group(0). Pipes drain before wait, so cancellation does not
                // release the leader PID and later signal an unrelated reused process.
                unsafe { libc::kill(-self.group, libc::SIGKILL) };
            }
        }

        /// Leaves successful or normally failed commands' detached descendants running.
        pub(super) fn disarm(&mut self) -> Result<(), String> {
            self.armed = false;
            Ok(())
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessIdOfThread, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
    };

    use super::{Child, Command};

    pub(super) struct ProcessTree {
        job: OwnedHandle,
        armed: bool,
    }

    /// Reports the platform error at the ownership operation that failed.
    fn error(operation: &str) -> String {
        format!(
            "Cannot own command process tree ({operation}): {}",
            std::io::Error::last_os_error()
        )
    }

    /// Configures only this unnamed, non-inherited job's lifetime flag.
    fn set_kill_on_close(job: &OwnedHandle, enabled: bool) -> Result<(), String> {
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        if enabled {
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        }
        // SAFETY: job is a live uniquely owned handle and limits has the exact
        // initialized structure/size expected by this synchronous native call.
        let updated = unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if updated == 0 {
            Err(error("job lifetime"))
        } else {
            Ok(())
        }
    }

    /// Resumes only suspended threads belonging to the newly created, still-owned child.
    fn resume_child(pid: u32) -> Result<(), String> {
        // SAFETY: this read-only snapshot has no borrowed memory or inherited handle.
        let raw_snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if raw_snapshot == INVALID_HANDLE_VALUE {
            return Err(error("thread snapshot"));
        }
        // SAFETY: a successful snapshot is a new owned kernel handle, closed exactly once.
        let snapshot = unsafe { OwnedHandle::from_raw_handle(raw_snapshot) };
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        // SAFETY: snapshot stays alive and entry is initialized with the required size.
        let mut available = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
        let mut resumed = false;
        while available {
            if entry.th32OwnerProcessID == pid {
                // SAFETY: the snapshot ID is filtered to our owned child, which cannot
                // execute user code before job assignment and this resume operation.
                let raw_thread = unsafe {
                    OpenThread(
                        THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                        0,
                        entry.th32ThreadID,
                    )
                };
                if raw_thread.is_null() {
                    return Err(error("open child thread"));
                }
                // SAFETY: OpenThread returned a new valid handle owned only by this scope.
                let thread = unsafe { OwnedHandle::from_raw_handle(raw_thread) };
                // SAFETY: this is a live thread handle with query rights. Rechecking
                // ownership closes the snapshot/OpenThread TID-reuse race.
                if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != pid {
                    return Err(
                        "Cannot own command process tree: child thread ownership changed".into(),
                    );
                }
                // SAFETY: the thread belongs to the suspended child already assigned
                // to our job. No parent or unrelated process thread can match its PID.
                let count = unsafe { ResumeThread(thread.as_raw_handle()) };
                if count == u32::MAX {
                    return Err(error("resume child thread"));
                }
                resumed |= count > 0;
            }
            // SAFETY: snapshot and correctly sized entry remain valid for this call.
            available = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
            if !available {
                // SAFETY: read the error immediately after the failed enumeration call.
                let code = unsafe { GetLastError() };
                if code != ERROR_NO_MORE_FILES {
                    return Err(format!(
                        "Cannot own command process tree (enumerate child threads): {}",
                        std::io::Error::from_raw_os_error(code as i32)
                    ));
                }
            }
        }
        if resumed {
            Ok(())
        } else {
            Err("Cannot own command process tree: no suspended child thread found".into())
        }
    }

    /// Assigns an unstarted child to a private kill-on-close job before any descendants can escape.
    pub(super) fn spawn(command: &mut Command) -> Result<(Child, ProcessTree), String> {
        // SAFETY: null security/name create an unnamed, non-inheritable owned job.
        let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw_job.is_null() {
            return Err(error("create job"));
        }
        // SAFETY: CreateJobObjectW returned a new handle transferred to exactly one owner.
        let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
        set_kill_on_close(&job, true)?;
        let tree = ProcessTree { job, armed: true };
        let child = command
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("Failed to spawn process: {error}"))?;
        let setup = (|| {
            let pid = child
                .id()
                .filter(|pid| *pid != 0)
                .ok_or_else(|| "Cannot own command process tree: missing child PID".to_string())?;
            let process = child.raw_handle().ok_or_else(|| {
                "Cannot own command process tree: missing child handle".to_string()
            })?;
            // SAFETY: process is borrowed from the still-owned suspended Child; job
            // remains uniquely owned. Neither handle is closed or inherited here.
            if unsafe { AssignProcessToJobObject(tree.job.as_raw_handle(), process) } == 0 {
                return Err(error("assign job"));
            }
            resume_child(pid)
        })();
        if let Err(error) = setup {
            tree.terminate();
            super::reap(child);
            return Err(error);
        }
        Ok((child, tree))
    }

    impl ProcessTree {
        /// Terminates only processes attached to this private job, independent of shell lifetime.
        pub(super) fn terminate(&self) {
            if self.armed {
                // SAFETY: the job is still uniquely owned and contains only our child
                // and its ordinary descendants, assigned before its first resume.
                unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) };
            }
        }

        /// Clears kill-on-close so a normally completed command can intentionally detach services.
        pub(super) fn disarm(&mut self) -> Result<(), String> {
            set_kill_on_close(&self.job, false)?;
            self.armed = false;
            Ok(())
        }
    }
}
