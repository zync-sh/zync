//! Persistence tests use disposable databases and synthetic reports, never the user's app data.
use super::*;
use serde_json::{json, Value};

/// A realistic public report is reused across import, library and export boundary tests.
pub(super) fn payload() -> Value {
    let mut value = crate::security::snapshots::tests::sample();
    value["version"] = 3.into();
    value["annotations"] = json!([]);
    value
}
/// Decode through the production validator rather than constructing unchecked identities in tests.
pub(super) fn subject(value: &Value) -> SnapshotSubject {
    decode_package(&serde_json::to_vec(value).unwrap(), current_time().unwrap())
        .unwrap()
        .result
        .subject
}

/// Near-limit JSON must remain importable and savable after normalized export, including retained notes.
#[test]
fn near_limit_reports_export_import_and_save_within_the_same_byte_budget() {
    let mut value = payload();
    value["report"]["version"] = "baseline".into();
    value["report"]["os"] = "ubuntu".into();
    value["report"]["policy"]["label"] = "General".into();
    value["report"]["policy"]["revision"] = "role-1".into();
    value["report"]["modules"][0]["label"] = "Host".into();
    value["report"]["modules"][0]["checkCount"] = 1000.into();
    let mut template = value["report"]["findings"][0].clone();
    template["title"] = "Fixture".into();
    template["target"] = "kernel.fixture".into();
    template["observed"] = "y".repeat(3926).into();
    template["expected"] = "Expected".into();
    template["rationale"] = "Rationale".into();
    template["scope"] = "Current value".into();
    template["evidence"] = "x".repeat(3926).into();
    template["recommendation"] = "Review".into();
    template["reference"] = "".into();
    template.as_object_mut().unwrap().remove("evidenceKind");
    template.as_object_mut().unwrap().remove("priority");
    let findings: Vec<_> = (0..1000)
        .map(|index| {
            let mut finding = template.clone();
            finding["id"] = format!("RULE-{index}").into();
            finding
        })
        .collect();
    let annotations: Vec<_> = findings
        .iter()
        .take(900)
        .enumerate()
        .map(|(index, finding)| {
            json!({"id":format!("00000000-0000-4000-8000-{index:012}"),
            "host":"fixture.invalid","username":"fixture","port":22,
            "transportFingerprint":value["report"]["transportFingerprint"],
            "policyId":"general","policyRevision":"role-1","moduleId":"host",
            "targetKey":finding["targetKey"],"ruleId":finding["id"],"ruleVersion":"1",
            "evidenceKey":finding["evidenceKey"],"reason":"r".repeat(500),
            "createdAt":1000,"expiresAt":5000})
        })
        .collect();
    value["report"]["findings"] = json!(findings);
    value["report"]["totalFindings"] = 1000.into();
    value["annotations"] = json!(annotations);
    let now = current_time().unwrap();
    let input = serde_json::to_vec(&value).unwrap();
    let cap = super::super::MAX_REPORT_BYTES + super::super::MAX_ANNOTATION_BYTES;
    assert!(input.len() <= cap);
    assert!(
        serde_json::to_vec_pretty(&value).unwrap().len() > cap,
        "Pretty-print expansion reproduces an otherwise valid package exceeding its raw import cap"
    );
    let package = decode_package(&input, now).unwrap();
    let encoded = encode_package(&package).unwrap();
    assert!(encoded.len() <= cap);
    let scope = {
        let imported = decode_package(&encoded, now).unwrap();
        assert_eq!(imported.result.report.findings.len(), 1000);
        assert_eq!(imported.annotations.len(), 900);
        imported.result.subject
    };
    drop(package);
    let folder = tempfile::tempdir().unwrap();
    let store = ReportLibrary::new(folder.path().join("near-limit.redb"));
    let saved = store
        .save(std::str::from_utf8(&encoded).unwrap(), "Near limit", None)
        .unwrap();
    let loaded = store.load(&saved.id, &scope).unwrap();
    assert_eq!(loaded.package.result.report.findings.len(), 1000);
    assert_eq!(loaded.package.annotations.len(), 900);
}

/// New reports survive reopening; metadata browsing does not need a live connection or its saved ID.
#[test]
fn reports_survive_reopen_and_keep_only_normalized_evidence() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("reports.redb");
    let mut value = payload();
    value["credentials"] = json!({"secret":"fixture-secret-never-persist"});
    let scope = subject(&value);
    let summary = {
        let store = ReportLibrary::new(path.clone());
        let first = store.save(&value.to_string(), "First", None).unwrap();
        store.save(&value.to_string(), "Second", None).unwrap();
        assert_eq!(store.list(&scope).unwrap().len(), 2);
        first
    };
    let store = ReportLibrary::new(path);
    let mut renamed = scope;
    renamed.connection_id = "restored-id".into();
    let saved = store.load(&summary.id, &renamed).unwrap();
    assert_eq!(saved.summary.name, "First");
    assert!(!String::from_utf8(encode_package(&saved.package).unwrap())
        .unwrap()
        .contains("fixture-secret"));
}

/// Device-wide browsing includes orphaned endpoints/accounts but reads only bounded index metadata.
#[test]
fn global_history_lists_scoped_summaries_without_reading_report_bodies() {
    let folder = tempfile::tempdir().unwrap();
    let store = ReportLibrary::new(folder.path().join("reports.redb"));
    let mut reports = Vec::new();
    for (host, username, port) in [
        ("fixture.invalid", "fixture", 22),
        ("other.invalid", "fixture", 22),
        ("fixture.invalid", "other", 22),
        ("fixture.invalid", "fixture", 2222),
    ] {
        let mut value = payload();
        value["subject"]["host"] = host.into();
        value["subject"]["username"] = username.into();
        value["subject"]["port"] = port.into();
        let scope = subject(&value);
        let summary = store
            .save(&value.to_string(), "Saved report", None)
            .unwrap();
        reports.push((scope, summary));
    }
    for (scope, summary) in &reports {
        let scoped = store.list(scope).unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].id, summary.id);
    }
    // Missing/corrupt bodies must not prevent metadata browsing or trigger risk-note migration.
    let database = store.database().unwrap();
    let tx = database.begin_write().unwrap();
    {
        let mut bodies = tx.open_table(REPORTS).unwrap();
        bodies.remove(reports[0].1.id.as_str()).unwrap();
        bodies
            .insert(reports[1].1.id.as_str(), b"invalid report".as_slice())
            .unwrap();
    }
    tx.commit().unwrap();
    let rows = store.list_all().unwrap();
    assert_eq!(rows.len(), reports.len());
    assert!(rows
        .windows(2)
        .all(|pair| pair[0].updated_at > pair[1].updated_at
            || pair[0].updated_at == pair[1].updated_at && pair[0].id <= pair[1].id));
    assert!(store.load(&reports[0].1.id, &reports[0].0).is_err());
    assert!(store.load(&reports[1].1.id, &reports[1].0).is_err());
    assert!(store.load(&reports[2].1.id, &reports[0].0).is_err());
}

/// Global enumeration retains the same corruption and record-count bounds as host-scoped browsing.
#[test]
fn global_history_rejects_invalid_or_oversized_metadata() {
    let folder = tempfile::tempdir().unwrap();
    let store = ReportLibrary::new(folder.path().join("reports.redb"));
    let value = payload();
    let scope = subject(&value);
    let saved = store
        .save(&value.to_string(), "Saved report", None)
        .unwrap();
    let database = store.database().unwrap();
    for invalid in [
        b"invalid metadata".to_vec(),
        vec![b' '; MAX_INDEX_BYTES + 1],
    ] {
        let tx = database.begin_write().unwrap();
        tx.open_table(INDEX)
            .unwrap()
            .insert(saved.id.as_str(), invalid.as_slice())
            .unwrap();
        tx.commit().unwrap();
        assert!(store.list_all().is_err());
        assert!(store.list(&scope).is_err());
    }
    let metadata = serde_json::to_vec(&saved).unwrap();
    let tx = database.begin_write().unwrap();
    {
        let mut index = tx.open_table(INDEX).unwrap();
        index
            .insert(saved.id.as_str(), metadata.as_slice())
            .unwrap();
        for _ in 0..MAX_RECORDS {
            let id = uuid::Uuid::new_v4().to_string();
            index.insert(id.as_str(), metadata.as_slice()).unwrap();
        }
    }
    tx.commit().unwrap();
    assert!(store.list_all().is_err());
    assert!(store.list(&scope).is_err());
}

/// Explicit replacement preserves ID, detects stale revisions, and rejects another endpoint or host key.
#[test]
fn replacements_and_deletion_are_atomic_scoped_and_revision_checked() {
    let folder = tempfile::tempdir().unwrap();
    let store = ReportLibrary::new(folder.path().join("reports.redb"));
    let value = payload();
    let scope = subject(&value);
    let original = store.save(&value.to_string(), "Original", None).unwrap();
    let revision = || Revision {
        id: original.id.clone(),
        revision: original.revision,
    };
    let updated = store
        .save(&value.to_string(), "Updated", Some(revision()))
        .unwrap();
    assert_eq!(updated.id, original.id);
    assert_eq!(updated.revision, 2);
    assert_eq!(store.list(&scope).unwrap().len(), 1);
    assert!(store
        .save(&value.to_string(), "Stale", Some(revision()))
        .is_err());
    let mut other = value.clone();
    other["subject"]["host"] = "other.invalid".into();
    assert!(store
        .save(
            &other.to_string(),
            "Wrong host",
            Some(Revision {
                id: updated.id.clone(),
                revision: 2
            })
        )
        .is_err());
    assert!(store.load(&original.id, &subject(&other)).is_err());
    assert!(store
        .delete(
            Revision {
                id: updated.id.clone(),
                revision: 1
            },
            &scope
        )
        .is_err());
    assert_eq!(
        store.load(&updated.id, &scope).unwrap().summary.name,
        "Updated"
    );
    store
        .delete(
            Revision {
                id: updated.id.clone(),
                revision: 2,
            },
            &scope,
        )
        .unwrap();
    assert!(store.list(&scope).unwrap().is_empty());
    assert!(store.load(&updated.id, &scope).is_err());
}

/// Accepted-risk notes retain reason/expiry across restarts; invalid input leaves the saved copy untouched.
#[test]
fn notes_roundtrip_and_invalid_saves_never_replace_evidence() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("reports.redb");
    let mut value = payload();
    let scope = subject(&value);
    let finding = &value["report"]["findings"][0];
    value["annotations"] = json!([{"id":uuid::Uuid::new_v4().to_string(),"host":"fixture.invalid","username":"fixture","port":22,
        "transportFingerprint":value["report"]["transportFingerprint"],"policyId":"general","policyRevision":"zync-role-1","moduleId":"host",
        "targetKey":finding["targetKey"],"ruleId":"LINUX-aslr","ruleVersion":"1","evidenceKey":finding["evidenceKey"],"reason":"Temporary exception","createdAt":1000,"expiresAt":5000}]);
    let mut foreign = value["annotations"][0].clone();
    foreign["id"] = uuid::Uuid::new_v4().to_string().into();
    foreign["host"] = "foreign.invalid".into();
    value["annotations"].as_array_mut().unwrap().push(foreign);
    let summary = {
        let store = ReportLibrary::new(path.clone());
        store.save(&value.to_string(), "With notes", None).unwrap()
    };
    let store = ReportLibrary::new(path);
    let saved = store.load(&summary.id, &scope).unwrap();
    assert_eq!(saved.package.annotations.len(), 1);
    assert!(!String::from_utf8(encode_package(&saved.package).unwrap())
        .unwrap()
        .contains("foreign.invalid"));
    assert_eq!(saved.package.annotations[0].expires_at, 5000);
    value["annotations"][0]["reason"] = "\u{202e}".into();
    assert!(store
        .save(
            &value.to_string(),
            "Invalid",
            Some(Revision {
                id: summary.id.clone(),
                revision: 1
            })
        )
        .is_err());
    assert_eq!(store.load(&summary.id, &scope).unwrap().summary.revision, 1);
}

/// The store never silently evicts reports when its fixed record quota is reached.
#[test]
fn report_quota_requires_explicit_replacement_or_deletion() {
    let folder = tempfile::tempdir().unwrap();
    let store = ReportLibrary::new(folder.path().join("reports.redb"));
    let value = payload();
    let scope = subject(&value);
    let first = store.save(&value.to_string(), "First", None).unwrap();
    for _ in 1..MAX_RECORDS {
        store.save(&value.to_string(), "Another", None).unwrap();
    }
    assert!(store.save(&value.to_string(), "Overflow", None).is_err());
    store
        .save(
            &value.to_string(),
            "Replacement",
            Some(Revision {
                id: first.id,
                revision: 1,
            }),
        )
        .unwrap();
    assert_eq!(store.list(&scope).unwrap().len() as u64, MAX_RECORDS);
    assert_eq!(store.list_all().unwrap().len() as u64, MAX_RECORDS);
}
