//! Explicit disposable-container qualification; ordinary tests never inspect a Docker engine or live host.
use super::*;
use crate::security::{jobs::Registry, modules::ExtraResult};
use serde::Deserialize;
use std::{path::PathBuf, sync::Arc};
use tokio::{io::AsyncReadExt, sync::Mutex};
use zeroize::{Zeroize, Zeroizing};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    run_id: String,
    ssh_port: u16,
    host_key: String,
    ssh_password: String,
    credentials: Vec<RuntimeCredential>,
}
impl Drop for Fixture {
    /// Fixture passwords are generated for one run and are never retained after the ignored test.
    fn drop(&mut self) {
        self.ssh_password.zeroize();
    }
}

/// Read only this harness's opt-in, ignored generated configuration, with an explicit byte cap.
async fn fixture() -> Fixture {
    assert_eq!(
        std::env::var("ZYNC_RUNTIME_QUALIFICATION").as_deref(),
        Ok("owned-docker-fixture"),
        "Set the explicit owned Docker fixture gate."
    );
    let path = PathBuf::from(
        std::env::var_os("ZYNC_RUNTIME_FIXTURE").expect("Set the generated fixture.json path."),
    );
    assert!(path.is_absolute());
    assert_eq!(
        path.file_name().and_then(|name| name.to_str()),
        Some("fixture.json")
    );
    let folder = path
        .parent()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .unwrap();
    let id = folder
        .strip_prefix("runtime-")
        .expect("Choose this harness's generated runtime folder.");
    uuid::Uuid::parse_str(id).expect("The fixture folder must have a run UUID.");
    assert_eq!(
        path.parent()
            .and_then(|path| path.parent())
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str()),
        Some(".tmp-agent-tests")
    );
    let file = tokio::fs::File::open(&path).await.unwrap();
    assert!(file.metadata().await.unwrap().is_file());
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(32_769).read_to_end(&mut bytes).await.unwrap();
    assert!(bytes.len() <= 32_768);
    let result: Fixture =
        serde_json::from_slice(&bytes).expect("Read the bounded generated fixture configuration.");
    assert_eq!(result.run_id, id);
    assert_ne!(result.ssh_port, 0);
    assert_eq!(result.credentials.len(), 3);
    let selected: Vec<_> = ["postgres-runtime", "mysql-runtime", "redis-runtime"]
        .iter()
        .map(|id| serde_json::from_value(Value::String((*id).into())).unwrap())
        .collect();
    validate_credentials(&result.credentials, &selected).unwrap();
    result
}

/// Connect through the production Client type with a generated pinned public key, without known-host writes.
async fn session(fixture: &Fixture) -> crate::security::jobs::Session {
    let material = fixture
        .host_key
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    let expected = russh::keys::PublicKey::from_openssh(&material).unwrap();
    let session = crate::ssh::connect_runtime_fixture(
        fixture.ssh_port,
        expected,
        "observer",
        &fixture.ssh_password,
    )
    .await
    .expect("Connect only to this generated, pinned loopback SSH fixture.");
    Arc::new(Mutex::new(Arc::new(session)))
}

/// Real PostgreSQL SCRAM, Redis ACL and Oracle MySQL CLI use the same captured SSH adapters as the product.
#[tokio::test]
#[ignore = "Requires explicitly prepared UUID-owned Docker runtime fixtures"]
async fn qualify_owned_runtime_observers() {
    let fixture = fixture().await;
    let session = session(&fixture).await;
    let jobs = Registry::default();
    let id = jobs
        .begin(
            format!("runtime-fixture-{}", fixture.run_id),
            session.clone(),
        )
        .unwrap();
    let lease = jobs.claim(&id).unwrap();
    let facts = tokio::time::timeout(
        Duration::from_secs(85),
        collect(&lease, &fixture.credentials),
    )
    .await
    .unwrap()
    .unwrap();
    for credential in &fixture.credentials {
        let output = facts
            .get(credential.kind.key())
            .expect("Every explicitly selected fixture must report.");
        assert!(
            !output.contains(&credential.secret),
            "A fixture credential must never enter an export envelope."
        );
        assert!(!output.contains(&fixture.ssh_password));
        let result: Value = serde_json::from_str(output).unwrap();
        assert!(
            result.get("error").is_none(),
            "The qualified observer did not produce application evidence."
        );
        assert!(target_key(&facts, credential.kind.module_id()).is_some());
    }
    assert!(matches!(
        evaluate(&facts, Check::PgPassword),
        ExtraResult::Available {
            outcome: crate::security::hardening::Outcome::Passed,
            ..
        }
    ));
    assert!(
        matches!(
            evaluate(&facts, Check::PgHbaErrors),
            ExtraResult::UnavailableWith { .. }
        ),
        "An ordinary PostgreSQL account must not gain protected HBA-file access."
    );
    assert!(matches!(
        evaluate(&facts, Check::MysqlTransport),
        ExtraResult::Available { .. }
    ));
    assert!(
        matches!(
            evaluate(&facts, Check::MysqlAdmins),
            ExtraResult::UnavailableWith { .. }
        ),
        "The USAGE-only MySQL observer must not read mysql.user."
    );
    assert!(matches!(
        evaluate(&facts, Check::RedisDefaultAdmin),
        ExtraResult::Available { .. }
    ));
    drop(lease);
    session
        .lock()
        .await
        .disconnect(
            russh::Disconnect::ByApplication,
            "Fixture qualification finished",
            "",
        )
        .await
        .unwrap();
}

/// Incorrect app passwords cannot fall back to a different identity or turn absence of evidence into a pass.
#[tokio::test]
#[ignore = "Requires explicitly prepared UUID-owned Docker runtime fixtures"]
async fn qualify_owned_runtime_wrong_credentials_and_cancellation() {
    let mut fixture = fixture().await;
    let session = session(&fixture).await;
    for credential in &mut fixture.credentials {
        credential.secret = "intentionally-wrong-fixture-credential".into();
    }
    let jobs = Registry::default();
    let id = jobs
        .begin(
            format!("runtime-fixture-{}", fixture.run_id),
            session.clone(),
        )
        .unwrap();
    let lease = jobs.claim(&id).unwrap();
    let facts = tokio::time::timeout(
        Duration::from_secs(85),
        collect(&lease, &fixture.credentials),
    )
    .await
    .unwrap()
    .unwrap();
    for (key, check) in [
        ("pg_runtime", Check::PgPassword),
        ("mysql_runtime", Check::MysqlTransport),
        ("redis_runtime", Check::RedisProtected),
    ] {
        let result: Value = serde_json::from_str(facts.get(key).unwrap()).unwrap();
        assert_eq!(result["error"], "authentication_failed");
        assert!(matches!(
            evaluate(&facts, check),
            ExtraResult::UnavailableWith { .. }
        ));
    }
    jobs.cancel(&id);
    assert!(tokio::time::timeout(
        Duration::from_secs(3),
        collect(&lease, &fixture.credentials)
    )
    .await
    .unwrap()
    .is_err());
    drop(lease);
    session
        .lock()
        .await
        .disconnect(
            russh::Disconnect::ByApplication,
            "Fixture qualification finished",
            "",
        )
        .await
        .unwrap();
}
