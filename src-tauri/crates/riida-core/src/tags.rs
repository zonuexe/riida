//! Book tag normalization and library-wide tag rename/delete.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookTagsPayload {
    pub file_path: String,
    pub tags: Vec<String>,
}

pub fn normalize_book_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }

        let owned = trimmed.to_string();
        if seen.insert(owned.clone()) {
            normalized.push(owned);
        }
    }

    normalized
}

fn validate_tag_value(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("Tag must not be empty.".to_string());
    }
    if value == "/" || value.starts_with('/') || value.ends_with('/') || value.contains("//") {
        return Err("Tag cannot start or end with '/', be just '/', or contain '//'.".to_string());
    }
    Ok(())
}

// Rename `old_tag` (and any descendant tags using it as a hierarchy prefix)
// to `new_tag`. Returns the number of distinct books whose tags changed.
//
// Hierarchy semantics: renaming `foo` to `bar` rewrites every tag whose path
// starts with `foo/` so that `foo/sub` becomes `bar/sub`. If a book already
// has the target tag, the rename collapses into it instead of duplicating.
pub fn rename_book_tag(
    connection: &mut Connection,
    old_tag: &str,
    new_tag: &str,
) -> Result<u64, String> {
    let old = old_tag.trim();
    let new = new_tag.trim();
    validate_tag_value(old)?;
    validate_tag_value(new)?;
    if old == new {
        return Ok(0);
    }

    let descendant_prefix = format!("{old}/");
    let descendant_prefix_len = descendant_prefix.len() as i64;

    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    let pairs: Vec<(String, String)> = {
        let mut statement = transaction
            .prepare(
                "
                SELECT file_path, tag
                FROM book_tags
                WHERE tag = ?1 OR substr(tag, 1, ?2) = ?3
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![old, descendant_prefix_len, &descendant_prefix],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|error| error.to_string())?;
        let mut collected = Vec::new();
        for row in rows {
            collected.push(row.map_err(|error| error.to_string())?);
        }
        collected
    };

    if pairs.is_empty() {
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(0);
    }

    let mut affected_books = HashSet::new();
    for (file_path, _) in &pairs {
        affected_books.insert(file_path.clone());
    }

    transaction
        .execute(
            "
            DELETE FROM book_tags
            WHERE tag = ?1 OR substr(tag, 1, ?2) = ?3
            ",
            params![old, descendant_prefix_len, &descendant_prefix],
        )
        .map_err(|error| error.to_string())?;

    for (file_path, tag) in &pairs {
        let renamed = if tag == old {
            new.to_string()
        } else {
            format!("{new}{}", &tag[old.len()..])
        };
        transaction
            .execute(
                "INSERT OR IGNORE INTO book_tags (file_path, tag) VALUES (?1, ?2)",
                params![file_path, renamed],
            )
            .map_err(|error| error.to_string())?;
    }

    transaction.commit().map_err(|error| error.to_string())?;
    Ok(affected_books.len() as u64)
}

// Remove `tag` and every descendant hierarchical tag (`tag/...`) from every
// book that currently has them. Returns the number of distinct affected
// books.
pub fn delete_book_tag(connection: &Connection, tag: &str) -> Result<u64, String> {
    let target = tag.trim();
    validate_tag_value(target)?;

    let descendant_prefix = format!("{target}/");
    let descendant_prefix_len = descendant_prefix.len() as i64;

    let affected_books: u64 = connection
        .query_row(
            "
            SELECT COUNT(DISTINCT file_path)
            FROM book_tags
            WHERE tag = ?1 OR substr(tag, 1, ?2) = ?3
            ",
            params![target, descendant_prefix_len, &descendant_prefix],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())? as u64;

    connection
        .execute(
            "
            DELETE FROM book_tags
            WHERE tag = ?1 OR substr(tag, 1, ?2) = ?3
            ",
            params![target, descendant_prefix_len, &descendant_prefix],
        )
        .map_err(|error| error.to_string())?;

    Ok(affected_books)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{book_tags_connection, collect_tags, insert_tag};

    #[test]
    fn normalize_book_tags_discards_empty_values_and_deduplicates() {
        let normalized = normalize_book_tags(vec![
            "  rust ".to_string(),
            "".to_string(),
            "pdf".to_string(),
            "rust".to_string(),
            "  ".to_string(),
            "PDF".to_string(),
        ]);

        assert_eq!(normalized, vec!["rust", "pdf", "PDF"]);
    }

    #[test]
    fn delete_book_tag_removes_exact_and_descendants_across_books() {
        let connection = book_tags_connection();
        insert_tag(&connection, "/a.pdf", "rust");
        insert_tag(&connection, "/a.pdf", "rust/async");
        insert_tag(&connection, "/a.pdf", "other");
        insert_tag(&connection, "/b.pdf", "rust/sync");
        insert_tag(&connection, "/c.pdf", "rusty"); // intentionally not a descendant
        insert_tag(&connection, "/c.pdf", "other");

        let affected = delete_book_tag(&connection, "rust").expect("delete should succeed");

        assert_eq!(affected, 2);
        assert_eq!(collect_tags(&connection, "/a.pdf"), vec!["other"]);
        assert!(collect_tags(&connection, "/b.pdf").is_empty());
        assert_eq!(
            collect_tags(&connection, "/c.pdf"),
            vec!["other", "rusty"],
            "siblings sharing only a name prefix must stay"
        );
    }

    #[test]
    fn delete_book_tag_returns_zero_for_unknown_tag() {
        let connection = book_tags_connection();
        insert_tag(&connection, "/a.pdf", "rust");

        let affected = delete_book_tag(&connection, "ghost").expect("delete should succeed");

        assert_eq!(affected, 0);
        assert_eq!(collect_tags(&connection, "/a.pdf"), vec!["rust"]);
    }

    #[test]
    fn delete_book_tag_rejects_invalid_input() {
        let connection = book_tags_connection();
        assert!(delete_book_tag(&connection, "").is_err());
        assert!(delete_book_tag(&connection, "  ").is_err());
        assert!(delete_book_tag(&connection, "/leading").is_err());
        assert!(delete_book_tag(&connection, "trailing/").is_err());
        assert!(delete_book_tag(&connection, "a//b").is_err());
    }

    #[test]
    fn rename_book_tag_renames_exact_and_descendants() {
        let mut connection = book_tags_connection();
        insert_tag(&connection, "/a.pdf", "rust");
        insert_tag(&connection, "/a.pdf", "rust/async");
        insert_tag(&connection, "/b.pdf", "rust/sync");
        insert_tag(&connection, "/c.pdf", "rusty"); // not a descendant

        let affected =
            rename_book_tag(&mut connection, "rust", "lang/rust").expect("rename should succeed");

        assert_eq!(affected, 2);
        assert_eq!(
            collect_tags(&connection, "/a.pdf"),
            vec!["lang/rust", "lang/rust/async"]
        );
        assert_eq!(collect_tags(&connection, "/b.pdf"), vec!["lang/rust/sync"]);
        assert_eq!(collect_tags(&connection, "/c.pdf"), vec!["rusty"]);
    }

    #[test]
    fn rename_book_tag_collapses_into_existing_target_tag() {
        let mut connection = book_tags_connection();
        insert_tag(&connection, "/a.pdf", "draft");
        insert_tag(&connection, "/a.pdf", "wip"); // already has both
        insert_tag(&connection, "/b.pdf", "draft");

        let affected =
            rename_book_tag(&mut connection, "draft", "wip").expect("rename should succeed");

        assert_eq!(affected, 2);
        assert_eq!(collect_tags(&connection, "/a.pdf"), vec!["wip"]);
        assert_eq!(collect_tags(&connection, "/b.pdf"), vec!["wip"]);
    }

    #[test]
    fn rename_book_tag_noop_when_unchanged() {
        let mut connection = book_tags_connection();
        insert_tag(&connection, "/a.pdf", "rust");

        let affected =
            rename_book_tag(&mut connection, "rust", "rust").expect("rename should succeed");

        assert_eq!(affected, 0);
        assert_eq!(collect_tags(&connection, "/a.pdf"), vec!["rust"]);
    }

    #[test]
    fn rename_book_tag_rejects_invalid_input() {
        let mut connection = book_tags_connection();
        insert_tag(&connection, "/a.pdf", "rust");

        assert!(rename_book_tag(&mut connection, "", "rust").is_err());
        assert!(rename_book_tag(&mut connection, "rust", "").is_err());
        assert!(rename_book_tag(&mut connection, "rust", "/bad").is_err());
        assert!(rename_book_tag(&mut connection, "rust", "bad/").is_err());
        assert!(rename_book_tag(&mut connection, "rust", "a//b").is_err());
        assert_eq!(collect_tags(&connection, "/a.pdf"), vec!["rust"]);
    }
}
