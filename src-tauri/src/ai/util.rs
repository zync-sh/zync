/// Converts a string to a filesystem-safe lowercase slug using first 5 words.
pub(crate) fn slugify(text: &str) -> String {
    text.split_whitespace()
        .take(5)
        .map(|word| {
            word.chars()
                .filter(|c| c.is_alphanumeric())
                .map(|c| c.to_ascii_lowercase())
                .collect::<String>()
        })
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slugify() {
        assert_eq!(slugify("Set up a Node.js server!"), "set-up-a-nodejs-server");
        assert_eq!(slugify("rm -rf everything else here"), "rm-rf-everything-else-here");
        assert_eq!(
            slugify("Write a comprehensive Python script that does amazing things"),
            "write-a-comprehensive-python-script"
        );
        assert_eq!(slugify("  spaces  "), "spaces");
        assert_eq!(slugify(""), "");
        assert_eq!(slugify("!!!"), "");
        assert_eq!(slugify("🚀 rocket"), "rocket");
    }
}
