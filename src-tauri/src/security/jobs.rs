use crate::ssh::Client;
use russh::client::Handle;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, watch, Mutex as AsyncMutex};
use zeroize::Zeroizing;

pub type Session = Arc<AsyncMutex<Arc<Handle<Client>>>>;

struct Job<T> {
    connection: String,
    session: T,
    cancel: watch::Sender<bool>,
    created: Instant,
    claimed: bool,
    password: Option<oneshot::Sender<Zeroizing<String>>>,
}

/// Bounded admission, with no queue and one assessment per SSH connection.
pub struct Registry<T>(Mutex<HashMap<String, Job<T>>>);
pub type SecurityJobs = Registry<Session>;

pub struct Lease<'a, T = Session> {
    service: &'a Registry<T>,
    pub id: String,
    pub connection: String,
    pub session: T,
    pub cancel: watch::Receiver<bool>,
}

impl<T> Default for Registry<T> {
    /// Admission can be tested with inert bindings instead of connecting to a real host.
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

impl<T> Drop for Lease<'_, T> {
    /// Release admission only after the runner has finished closing its channel.
    fn drop(&mut self) {
        self.service.0.lock().unwrap().remove(&self.id);
    }
}

impl<T: Clone> Registry<T> {
    /// Register before the renderer starts work, preserving an early cancellation.
    pub fn begin(&self, connection: String, session: T) -> Result<String, String> {
        let mut jobs = self.0.lock().unwrap();
        jobs.retain(|_, job| job.claimed || job.created.elapsed() < Duration::from_secs(30));
        if jobs.len() >= 2 || jobs.values().any(|job| job.connection == connection) {
            return Err("An assessment is already running on this server, or two assessments are running elsewhere. Try again shortly.".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        jobs.insert(
            id.clone(),
            Job {
                connection,
                session,
                cancel: watch::channel(false).0,
                created: Instant::now(),
                claimed: false,
                password: None,
            },
        );
        Ok(id)
    }

    /// Claim once; the transport captured at registration never changes on reconnect.
    pub fn claim(&self, id: &str) -> Result<Lease<'_, T>, String> {
        let mut jobs = self.0.lock().unwrap();
        let job = jobs
            .get_mut(id)
            .ok_or("Assessment expired or was cancelled. Start a new assessment.")?;
        if job.claimed || job.created.elapsed() >= Duration::from_secs(30) {
            return Err("This assessment can no longer be started. Start a new assessment.".into());
        }
        job.claimed = true;
        Ok(Lease {
            service: self,
            id: id.into(),
            connection: job.connection.clone(),
            session: job.session.clone(),
            cancel: job.cancel.subscribe(),
        })
    }

    /// Wake an active runner or remove an unclaimed registration immediately.
    pub fn cancel(&self, id: &str) {
        let mut jobs = self.0.lock().unwrap();
        if let Some(job) = jobs.get(id) {
            job.cancel.send_replace(true);
            if !job.claimed {
                jobs.remove(id);
            }
        }
    }

    /// Stop all owned work when the main renderer reloads or is destroyed.
    pub fn cancel_all(&self) {
        self.0.lock().unwrap().retain(|_, job| {
            job.cancel.send_replace(true);
            job.claimed
        });
    }

    /// Open one run-bound secret mailbox only after the exact native sudo prompt.
    pub fn request_password(
        &self,
        id: &str,
    ) -> Result<oneshot::Receiver<Zeroizing<String>>, String> {
        let mut jobs = self.0.lock().unwrap();
        let job = jobs
            .get_mut(id)
            .filter(|job| job.claimed && !*job.cancel.borrow())
            .ok_or("Assessment is no longer active.")?;
        if job.password.is_some() {
            return Err("Sudo authentication is already pending.".into());
        }
        let (sender, receiver) = oneshot::channel();
        job.password = Some(sender);
        Ok(receiver)
    }

    /// Polling exposes no credential or prompt text, only whether this live run needs an answer.
    pub fn needs_password(&self, id: &str) -> bool {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|job| !*job.cancel.borrow() && job.password.is_some())
    }

    /// Consume one answer; stale IDs, cancelled runs and unsolicited submissions cannot retain a password.
    pub fn authenticate(&self, id: &str, password: Zeroizing<String>) -> Result<(), String> {
        super::sudo::validate_password(&password)?;
        let mut jobs = self.0.lock().unwrap();
        let job = jobs
            .get_mut(id)
            .filter(|job| job.claimed && !*job.cancel.borrow())
            .ok_or("Assessment is no longer active.")?;
        job.password
            .take()
            .ok_or("This assessment is not requesting a sudo password.")?
            .send(password)
            .map_err(|_| "Sudo authentication request expired.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cancellation retains active admission until the actual native lease is dropped.
    #[test]
    fn bounded_admission_claim_and_cancel() {
        let jobs = Registry::default();
        let first = jobs.begin("first".into(), ()).unwrap();
        assert!(jobs.begin("first".into(), ()).is_err());
        let second = jobs.begin("second".into(), ()).unwrap();
        assert!(jobs.begin("overflow".into(), ()).is_err());
        let lease = jobs.claim(&first).unwrap();
        assert!(jobs.claim(&first).is_err());
        jobs.cancel(&first);
        assert!(*lease.cancel.borrow());
        assert!(jobs.begin("first".into(), ()).is_err());
        jobs.cancel(&second);
        assert!(jobs.claim(&second).is_err());
        drop(lease);
        assert!(jobs.begin("first".into(), ()).is_ok());
    }

    /// Reload removes pending jobs and wakes owned runners without prematurely freeing slots.
    #[test]
    fn shutdown_and_expired_registrations() {
        let jobs = Registry::default();
        let first = jobs.begin("first".into(), ()).unwrap();
        let lease = jobs.claim(&first).unwrap();
        let pending = jobs.begin("pending".into(), ()).unwrap();
        jobs.cancel_all();
        assert!(*lease.cancel.borrow());
        assert!(jobs.claim(&pending).is_err());
        assert_eq!(jobs.0.lock().unwrap().len(), 1);
        drop(lease);
        let stale = jobs.begin("stale".into(), ()).unwrap();
        jobs.0.lock().unwrap().get_mut(&stale).unwrap().created =
            Instant::now() - Duration::from_secs(31);
        assert!(jobs.claim(&stale).is_err());
        assert!(jobs.begin("stale".into(), ()).is_ok());
        jobs.cancel("unknown");
    }

    /// Only one live challenge accepts a secret; cancellation and stale ownership reject later submissions.
    #[tokio::test]
    async fn password_mailbox_is_one_shot_and_run_bound() {
        let jobs = Registry::default();
        let id = jobs.begin("host".into(), ()).unwrap();
        let lease = jobs.claim(&id).unwrap();
        assert!(!jobs.needs_password(&id));
        assert!(jobs
            .authenticate(&id, Zeroizing::new("not-requested".into()))
            .is_err());
        let receiver = jobs.request_password(&id).unwrap();
        assert!(jobs.needs_password(&id));
        assert!(jobs
            .authenticate(&id, Zeroizing::new("bad\ninput".into()))
            .is_err());
        jobs.authenticate(&id, Zeroizing::new("once".into()))
            .unwrap();
        assert_eq!(&**receiver.await.unwrap(), "once");
        assert!(!jobs.needs_password(&id));
        assert!(jobs
            .authenticate(&id, Zeroizing::new("twice".into()))
            .is_err());
        let _waiting = jobs.request_password(&id).unwrap();
        jobs.cancel(&id);
        assert!(!jobs.needs_password(&id));
        assert!(jobs
            .authenticate(&id, Zeroizing::new("cancelled".into()))
            .is_err());
        drop(lease);
        assert!(jobs.request_password(&id).is_err());
    }
}
