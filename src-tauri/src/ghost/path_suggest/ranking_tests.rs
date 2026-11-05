//! Selection parity is checked against the pre-optimization stable comparator.

use super::*;

fn entry(name: &str, kind: &str, identity: usize) -> FileEntry {
    FileEntry {
        name: name.into(),
        path: identity.to_string(),
        r#type: kind.into(),
        size: 0,
        last_modified: 0,
        permissions: String::new(),
        owner: String::new(),
        group: String::new(),
    }
}

fn legacy_bonus(name: &str, recent: &[String]) -> i32 {
    let name_lower = name.to_ascii_lowercase();
    let mut bonus = 0;
    for line in recent {
        if line.to_ascii_lowercase().contains(&name_lower) {
            bonus = bonus.max(2);
        }
    }
    bonus
}

fn legacy_selection<'a>(
    entries: &'a [FileEntry],
    partial: &str,
    windows: bool,
    directory_only: bool,
    recent: &[String],
    limit: usize,
) -> Vec<&'a FileEntry> {
    let mut matches: Vec<_> = entries
        .iter()
        .filter(|e| {
            e.name != "."
                && e.name != ".."
                && e.name != partial
                && path_entry_suffix(&e.name, partial, windows).is_some()
        })
        .collect();
    if directory_only {
        matches.retain(|e| matches!(normalize_entry_type(&e.r#type), "directory" | "symlink"));
    }
    matches.retain(|e| !e.name.ends_with('~'));
    matches.sort_by(|a, b| {
        let recent_a = legacy_bonus(&a.name, recent);
        let recent_b = legacy_bonus(&b.name, recent);
        if recent_a != recent_b {
            return recent_a.cmp(&recent_b).reverse();
        }
        let exact_a = !partial.is_empty() && a.name.starts_with(partial);
        let exact_b = !partial.is_empty() && b.name.starts_with(partial);
        if exact_a != exact_b {
            return exact_a.cmp(&exact_b).reverse();
        }
        let dir_a = normalize_entry_type(&a.r#type) == "directory";
        let dir_b = normalize_entry_type(&b.r#type) == "directory";
        if dir_a != dir_b {
            return dir_a.cmp(&dir_b).reverse();
        }
        a.name.cmp(&b.name)
    });
    matches.into_iter().take(limit.max(1)).collect()
}

#[test]
fn cached_ranks_and_single_pass_match_legacy_order_for_all_limits_and_filters() {
    let mut entries: Vec<_> = [
        (".", "d"),
        ("..", "d"),
        ("docs", "d"),
        ("Documents", "directory"),
        ("documents", "l"),
        ("document", "file"),
        ("Docs", "file"),
        ("docs~", "d"),
        ("École", "d"),
        ("école", "d"),
        ("e\u{301}cole", "directory"),
        ("résumé", "file"),
        ("École~", "directory"),
        (" duplicate", "file"),
        ("\tduplicate", "l"),
        ("same", "l"),
        ("same", "file"),
        ("same", "file"),
        ("", "file"),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, (name, kind))| entry(name, kind, i))
    .collect();
    let recent_sets = [
        Vec::new(),
        vec![
            "cd DOCUMENTS".into(),
            "cat résumé".into(),
            "cd ÉCOLE".into(),
            "cd e\u{301}COLE".into(),
        ],
    ];
    for order in 0..4 {
        if order == 2 {
            entries.reverse();
        } else {
            entries.rotate_left(3);
        }
        for recent in &recent_sets {
            let context = RecentEntryContext::new(recent);
            for partial in [
                "", "d", "D", "doc", "docs", "é", "É", "e\u{301}", "same", "missing",
            ] {
                for windows in [false, true] {
                    for directory_only in [false, true] {
                        for limit in [0, 1, 2, 5, 40] {
                            let expected = legacy_selection(
                                &entries,
                                partial,
                                windows,
                                directory_only,
                                recent,
                                limit,
                            );
                            let actual = select_path_entries(
                                &entries,
                                partial,
                                windows,
                                directory_only,
                                limit,
                                |entry| rank_path_entry(entry, partial, &context),
                            );
                            let ids = |values: Vec<&FileEntry>| {
                                values
                                    .into_iter()
                                    .map(|e| e.path.clone())
                                    .collect::<Vec<_>>()
                            };
                            assert_eq!(ids(actual), ids(expected), "order={order}, partial={partial:?}, windows={windows}, dirs={directory_only}, limit={limit}");
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn each_eligible_entry_is_ranked_once_for_one_or_multiple_results() {
    let entries: Vec<_> = (0..1000)
        .map(|i| entry(&format!("file-{i:04}"), "file", i))
        .chain([
            entry("file-backup~", "file", 1000),
            entry("unrelated", "file", 1001),
            entry("file-", "file", 1002),
            entry(".", "d", 1003),
            entry("..", "d", 1004),
        ])
        .collect();
    let context = RecentEntryContext::new(&["cat FILE-0999".into()]);
    for limit in [0, 1, 10] {
        let mut ranked = 0;
        let selected = select_path_entries(&entries, "file-", false, false, limit, |entry| {
            ranked += 1;
            rank_path_entry(entry, "file-", &context)
        });
        assert_eq!(ranked, 1000);
        assert_eq!(selected[0].name, "file-0999");
        assert_eq!(selected.len(), limit.max(1));
    }
}

#[test]
fn first_full_tie_wins_and_symlinks_do_not_receive_real_directory_rank() {
    let entries = [
        entry("twin", "l", 0),
        entry("twin", "file", 1),
        entry("twin", "file", 2),
    ];
    let context = RecentEntryContext::new(&[]);
    for limit in [0, 1] {
        let selected = select_path_entries(&entries, "", false, false, limit, |e| {
            rank_path_entry(e, "", &context)
        });
        assert!(std::ptr::eq(selected[0], &entries[0]));
        assert_eq!(
            path_suggestion_suffix(selected[0], "", false, '/', true),
            " twin/"
        );
    }
    let selected = select_path_entries(&entries, "", false, false, 3, |e| {
        rank_path_entry(e, "", &context)
    });
    assert_eq!(
        selected.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
        ["0", "1", "2"]
    );
    let entries = [entry("aaa-link", "l", 0), entry("zzz-dir", "d", 1)];
    let selected = select_path_entries(&entries, "", false, true, 1, |e| {
        rank_path_entry(e, "", &context)
    });
    assert_eq!(selected[0].name, "zzz-dir");
}

#[test]
fn prepared_recent_evidence_keeps_ascii_only_matching_and_legacy_substrings() {
    let recent = [
        "CD ÉCOLE".into(),
        "cat e\u{301}COLE.txt".into(),
        "open Résumé".into(),
    ];
    let context = RecentEntryContext::new(&recent);
    for name in [
        "École",
        "école",
        "e\u{301}cole",
        "Résumé",
        "résumé",
        "missing",
        "",
        "COLE",
    ] {
        assert_eq!(
            context.name_bonus(name),
            legacy_bonus(name, &recent),
            "{name:?}"
        );
    }
    assert_eq!(context.name_bonus("École"), 2);
    assert_eq!(context.name_bonus("école"), 0);
}

#[test]
fn suffix_casing_new_argument_spacing_and_directory_separators_are_unchanged() {
    for (name, kind, partial, windows, sep, new_arg, expected) in [
        ("Documents", "d", "Doc", false, '/', false, "uments/"),
        ("Documents", "d", "doc", true, '\\', false, "uments\\"),
        ("Documents", "d", "", false, '/', true, " Documents/"),
        ("link", "l", "li", false, '/', false, "nk/"),
        ("Résumé.txt", "file", "Ré", false, '/', false, "sumé.txt"),
        (" leading", "file", "", false, '/', true, " leading"),
        ("\tleading", "file", "", false, '/', true, "\tleading"),
        ("Documents", "d", "documents", true, '\\', false, "\\"),
        ("file", "file", "file", false, '/', true, ""),
    ] {
        assert_eq!(
            path_suggestion_suffix(&entry(name, kind, 0), partial, windows, sep, new_arg),
            expected
        );
    }
}
