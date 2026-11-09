//! Files are inspected as actual CSV/OOXML, including host-controlled formula-like values.
use super::*;
use quick_xml::{events::Event, Reader};
use std::io::Read;

/// Keep OOXML cell-style indexes intact across both empty and paired xf elements.
fn wrapped_cell_styles(source: &str) -> Vec<bool> {
    let mut reader = Reader::from_str(source);
    let mut depth = 0usize;
    let mut cell_xfs_depth = None;
    let mut active_style = None;
    let mut wrapped = vec![];
    loop {
        let event = reader.read_event().unwrap();
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(node) | Event::Empty(node) => {
                match node.name().as_ref() {
                    b"cellXfs" => cell_xfs_depth = Some(depth),
                    b"xf" if cell_xfs_depth == depth.checked_sub(1) => {
                        wrapped.push(false);
                        active_style = (!empty).then_some(wrapped.len() - 1);
                    }
                    b"alignment" if cell_xfs_depth == depth.checked_sub(2) => {
                        if let Some(index) = active_style {
                            wrapped[index] = node.attributes().any(|attribute| {
                                let attribute = attribute.unwrap();
                                attribute.key.as_ref() == b"wrapText"
                                    && attribute.value.as_ref() == b"1"
                            });
                        }
                    }
                    _ => {}
                }
                if !empty {
                    depth += 1;
                }
            }
            Event::End(node) => {
                depth -= 1;
                match node.name().as_ref() {
                    b"xf" if cell_xfs_depth == depth.checked_sub(1) => active_style = None,
                    b"cellXfs" => break,
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    wrapped
}

/// Build a complete normalized package with malicious-looking but inert text evidence.
fn package() -> ReportPackage {
    let mut value = crate::security::snapshots::tests::sample();
    value["version"] = 3.into();
    value["annotations"] = serde_json::json!([]);
    value["report"]["findings"][0]["evidence"] =
        "=HYPERLINK(\"https://fixture.invalid\",\"test\")".into();
    value["report"]["findings"][0]["observed"] = "Text, with \"quotes\"".into();
    value["report"]["findings"][0]["remediation"] = serde_json::json!({
        "change":"=HYPERLINK(\"https://fixture.invalid\",\"guide\")",
        "impact":"May affect compatibility", "verification":"Check the observed value",
        "rollback":"Restore the previous setting"
    });
    decode_package(&serde_json::to_vec(&value).unwrap(), 10000).unwrap()
}

/// CSV protects leading and whitespace-prefixed formula forms without breaking quote/comma boundaries.
#[test]
fn csv_is_complete_quoted_and_formula_neutralized() {
    for value in ["=1+1", " +1", "-1", "@SUM(A1)", " ＝1+1"] {
        assert!(csv_cell(value).starts_with("\"\t"));
    }
    assert_eq!(csv_cell("a,\"b\""), "\"a,\"\"b\"\"\"");
    let output = String::from_utf8(csv(&package(), 10000)).unwrap();
    assert!(output.starts_with('\u{feff}'));
    assert!(output.contains("\"\t=HYPERLINK(\"\"https://fixture.invalid\"\""));
    assert!(output.contains("\"Text, with \"\"quotes\"\"\""));
    assert!(output.contains("Needs attention"));
    assert!(
        output
            .lines()
            .next()
            .unwrap()
            .contains("\"Baseline\",\"Preset\",\"Area\""),
        "CSV rows retain report context for combining exports"
    );
    let header = output.split("\r\n").next().unwrap();
    assert_eq!(header.matches("\",\"").count() + 1, 23);
    assert!(header.contains("\"Recommendation / next step\",\"How to address it\",\"Reference\""));
    assert!(output.contains("Change: =HYPERLINK(\"\"https://fixture.invalid\"\",\"\"guide\"\")\nImpact: May affect compatibility\nVerify: Check the observed value\nUndo: Restore the previous setting"));
    assert_eq!(
        output.split("\r\n").filter(|line| !line.is_empty()).count(),
        2
    );
}

/// Expired or not-yet-active renewals supersede older live notes in both spreadsheet formats.
#[test]
fn spreadsheet_acceptance_uses_latest_matching_note_before_time_checks() {
    for (created_at, expires_at) in [(3000, 9000), (11000, 12000), (1000, 9000)] {
        let mut package = package();
        let finding = &package.result.report.findings[0];
        let note = serde_json::json!({"id":uuid::Uuid::new_v4().to_string(),
            "host":"fixture.invalid","username":"fixture","port":22,
            "transportFingerprint":package.result.report.transport_fingerprint,
            "policyId":"general","policyRevision":"zync-role-1","moduleId":"host",
            "targetKey":finding.target_key,"ruleId":finding.id,"ruleVersion":finding.rule_version,
            "evidenceKey":finding.evidence_key,"reason":"Old live note","createdAt":1000,"expiresAt":20000});
        let old: Annotation = serde_json::from_value(note).unwrap();
        let mut newer = old.clone();
        newer.id = uuid::Uuid::new_v4().to_string();
        newer.reason = "Superseding recorded note".into();
        newer.created_at = created_at;
        newer.expires_at = expires_at;
        package.annotations = vec![old, newer];
        let normalized = decode_package(&encode_package(&package).unwrap(), 10000).unwrap();
        assert_eq!(
            normalized.annotations.len(),
            2,
            "Historical notes remain recorded"
        );
        assert!(annotation(&normalized, &normalized.result.report.findings[0], 10000).is_none());
        let values = row(&normalized, &normalized.result.report.findings[0], 10000);
        assert_eq!(values[20], "No");
        assert!(values[21].is_empty() && values[22].is_empty());
        let csv = String::from_utf8(csv(&normalized, 10000)).unwrap();
        assert!(!csv.contains("Old live note") && !csv.contains("Superseding recorded note"));
        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(xlsx(&normalized, 10000).unwrap())).unwrap();
        let mut strings = String::new();
        archive
            .by_name("xl/sharedStrings.xml")
            .unwrap()
            .read_to_string(&mut strings)
            .unwrap();
        assert!(
            !strings.contains("Old live note") && !strings.contains("Superseding recorded note")
        );
    }
}

/// Excel cells are strings, with no formulas, links, macros or missing report context.
#[test]
fn xlsx_has_summary_and_filterable_findings_without_executable_cells() {
    let bytes = xlsx(&package(), 10000).unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names = archive.file_names().collect::<Result<Vec<_>, _>>().unwrap();
    assert!(!names
        .iter()
        .any(|name| name.contains("externalLink") || name.contains("vbaProject")));
    let mut xml = String::new();
    archive
        .by_name("xl/workbook.xml")
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    assert!(xml.contains("Summary") && xml.contains("Findings"));
    xml.clear();
    archive
        .by_name("xl/worksheets/sheet2.xml")
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    assert!(!xml.contains("<f>"));
    assert!(xml.contains("autoFilter") && xml.contains("frozen"));
    assert!(
        xml.contains("ref=\"A1:U2\""),
        "The Findings autofilter covers its 21 retained columns"
    );
    assert!(
        regex::Regex::new(r#"<col min="(\d+)" max="(\d+)" width="([\d.]+)""#)
            .unwrap()
            .captures_iter(&xml)
            .any(|column| {
                column[1].parse::<u16>().unwrap() <= 16
                    && column[2].parse::<u16>().unwrap() >= 16
                    && (48.0..50.0).contains(&column[3].parse::<f64>().unwrap())
            }),
        "The guidance column has the same readable width as other long text"
    );
    let findings_xml = xml.clone();
    xml.clear();
    archive
        .by_name("xl/sharedStrings.xml")
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    assert!(
        xml.contains("=HYPERLINK")
            && xml.contains("fixture.invalid")
            && xml.contains("Needs attention")
    );
    let shared: Vec<_> = xml.split("</si>").collect();
    let string_index = |label: &str| {
        shared
            .iter()
            .position(|item| item.contains(&format!(">{label}</t>")))
            .unwrap()
    };
    let baseline = string_index("Baseline");
    let preset = string_index("Preset");
    let area = string_index("Area");
    let guidance = string_index("How to address it");
    let header = findings_xml.split("</row>").next().unwrap();
    assert!(
        !header.contains(&format!("<v>{baseline}</v>"))
            && !header.contains(&format!("<v>{preset}</v>")),
        "Report metadata is not repeated in Findings"
    );
    assert!(
        regex::Regex::new(&format!(r#"<c r="E1"[^>]*><v>{area}</v></c>"#))
            .unwrap()
            .is_match(header),
        "Area keeps the correct column and row alignment"
    );
    assert!(
        regex::Regex::new(&format!(r#"<c r="P1"[^>]*><v>{guidance}</v></c>"#))
            .unwrap()
            .is_match(header),
        "Structured guidance occupies one column after the next step"
    );
    assert!(
        xml.contains("Change: =HYPERLINK") && xml.contains("Undo: Restore the previous setting")
    );
    let guide_style = regex::Regex::new(r#"<c r="P2" s="(\d+)" t="s">"#)
        .unwrap()
        .captures(&findings_xml)
        .unwrap()[1]
        .parse::<usize>()
        .unwrap();
    let mut styles = String::new();
    archive
        .by_name("xl/styles.xml")
        .unwrap()
        .read_to_string(&mut styles)
        .unwrap();
    assert_eq!(
        wrapped_cell_styles(&styles).get(guide_style),
        Some(&true),
        "Guidance cells wrap their four labeled sections"
    );
    let mut summary_xml = String::new();
    archive
        .by_name("xl/worksheets/sheet1.xml")
        .unwrap()
        .read_to_string(&mut summary_xml)
        .unwrap();
    assert!(
        summary_xml.contains(&format!("<v>{baseline}</v>"))
            && summary_xml.contains(&format!("<v>{preset}</v>")),
        "Summary retains baseline and preset context"
    );
}

/// Version-3 JSON retains explicit notes and remains readable by the shared import validator.
#[test]
fn json_package_roundtrips_and_legacy_imports_remain_supported() {
    let package = package();
    let encoded = encode_package(&package).unwrap();
    let decoded = decode_package(&encoded, 10000).unwrap();
    assert_eq!(decoded.result.report.findings.len(), 1);
    assert_eq!(
        decoded.result.report.findings[0].remediation,
        package.result.report.findings[0].remediation
    );
    assert!(decoded.annotations.is_empty());
    let legacy = crate::security::snapshots::tests::sample();
    let legacy = decode_package(&serde_json::to_vec(&legacy).unwrap(), 10000).unwrap();
    assert!(legacy.annotations.is_empty());
    assert!(legacy.result.report.findings[0].remediation.is_none());
    assert!(!String::from_utf8(encode_package(&legacy).unwrap())
        .unwrap()
        .contains("remediation"));
}

/// Duplicate JSON identities cannot acquire different meanings in storage, import and spreadsheet exports.
#[test]
fn portable_reports_reject_duplicate_identity_fields() {
    let encoded = String::from_utf8(encode_package(&package()).unwrap()).unwrap();
    let duplicate = encoded.replacen("\"version\":3", "\"version\":3,\"version\":3", 1);
    assert!(decode_package(duplicate.as_bytes(), 10000).is_err());
    let duplicate = encoded.replacen(
        "\"host\":\"fixture.invalid\"",
        "\"host\":\"fixture.invalid\",\"host\":\"other.invalid\"",
        1,
    );
    assert!(decode_package(duplicate.as_bytes(), 10000).is_err());
}
