//! SQLite schema setup and one-time data migrations.

use rusqlite::{params, Connection};
use std::fs;
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

/// Open the database at `database_file`, creating it, its schema, and any
/// missing columns as needed.
pub fn open_database_at(database_file: &Path) -> Result<Connection, String> {
    if let Some(parent) = database_file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let connection = Connection::open(database_file).map_err(|error| error.to_string())?;

    // WAL keeps readers from blocking the writer and is safe for the
    // out-of-process MCP writer that shares this database. `synchronous =
    // NORMAL` is the recommended companion for WAL and avoids an fsync on
    // every commit. `busy_timeout` lets a concurrent writer (e.g. the MCP
    // server) finish instead of failing immediately with SQLITE_BUSY.
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;
            ",
        )
        .map_err(|error| error.to_string())?;

    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS books (
              id INTEGER PRIMARY KEY,
              file_path TEXT NOT NULL UNIQUE,
              file_name TEXT NOT NULL,
              file_size INTEGER NOT NULL,
              modified_at INTEGER NOT NULL,
              indexed_at INTEGER NOT NULL,
              source_type TEXT NOT NULL DEFAULT 'pdf'
            );
            CREATE TABLE IF NOT EXISTS notes (
              id INTEGER PRIMARY KEY,
              file_path TEXT NOT NULL UNIQUE,
              format TEXT NOT NULL,
              content TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS viewer_preferences (
              scope_key TEXT PRIMARY KEY,
              file_path TEXT UNIQUE,
              source_type TEXT NOT NULL DEFAULT 'pdf',
              page_mode TEXT NOT NULL,
              binding_direction TEXT NOT NULL,
              zoom_mode TEXT NOT NULL,
              align_mode TEXT NOT NULL,
              vertical_gap_mode TEXT NOT NULL,
              treat_first_page_as_cover INTEGER NOT NULL,
              background_mode TEXT NOT NULL DEFAULT 'inherit-theme',
              scroll_mode TEXT NOT NULL DEFAULT 'paged',
              epub_font_size INTEGER NOT NULL DEFAULT 100,
              deskew_mode TEXT NOT NULL DEFAULT 'off',
              trim_mode TEXT NOT NULL DEFAULT 'off',
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reading_positions (
              file_path TEXT PRIMARY KEY,
              page_number INTEGER NOT NULL,
              page_offset_ratio REAL NOT NULL,
              cfi TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS book_tags (
              file_path TEXT NOT NULL,
              tag TEXT NOT NULL,
              PRIMARY KEY (file_path, tag)
            );
            CREATE TABLE IF NOT EXISTS book_metadata (
              file_path TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              authors_json TEXT NOT NULL,
              description TEXT NOT NULL,
              publisher TEXT NOT NULL,
              release_date TEXT NOT NULL,
              language TEXT NOT NULL,
              url TEXT NOT NULL,
              asin TEXT NOT NULL,
              cover_url TEXT NOT NULL DEFAULT '',
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS external_books (
              file_path TEXT PRIMARY KEY,
              source_type TEXT NOT NULL,
              title TEXT NOT NULL,
              authors_json TEXT NOT NULL,
              description TEXT NOT NULL,
              publisher TEXT NOT NULL,
              release_date TEXT NOT NULL,
              language TEXT NOT NULL,
              url TEXT NOT NULL,
              asin TEXT NOT NULL,
              cover_url TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS custom_sources (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              icon TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pdf_passwords (
              file_path TEXT PRIMARY KEY,
              password TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS shelves (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              query TEXT NOT NULL,
              icon TEXT,
              sort_order INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS fulltext_index (
              file_path TEXT PRIMARY KEY,
              body_modified_at INTEGER,
              indexed_at INTEGER,
              status TEXT NOT NULL DEFAULT 'pending',
              error TEXT
            );
            ",
        )
        .map_err(|error| error.to_string())?;

    let _ = connection.execute(
        "ALTER TABLE book_metadata ADD COLUMN cover_url TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE books ADD COLUMN source_type TEXT NOT NULL DEFAULT 'pdf'",
        [],
    );
    let _ = connection.execute("ALTER TABLE reading_positions ADD COLUMN cfi TEXT", []);
    let _ = connection.execute(
        "ALTER TABLE viewer_preferences ADD COLUMN source_type TEXT NOT NULL DEFAULT 'pdf'",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE viewer_preferences ADD COLUMN background_mode TEXT NOT NULL DEFAULT 'inherit-theme'",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE viewer_preferences ADD COLUMN scroll_mode TEXT NOT NULL DEFAULT 'paged'",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE viewer_preferences ADD COLUMN epub_font_size INTEGER NOT NULL DEFAULT 100",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE viewer_preferences ADD COLUMN deskew_mode TEXT NOT NULL DEFAULT 'off'",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE viewer_preferences ADD COLUMN trim_mode TEXT NOT NULL DEFAULT 'off'",
        [],
    );

    migrate_paths_to_nfc(&connection).map_err(|error| error.to_string())?;

    Ok(connection)
}

/// One-time migration: convert any NFD file_path values to NFC across all tables.
///
/// macOS (HFS+/APFS) returns NFD strings from the file system API. Previous
/// versions of the app wrote those raw NFD paths into the database. External
/// writers such as the MCP server write NFC paths. This mismatch silently
/// breaks JOINs between `books` and `book_metadata`. Running this on every
/// startup is idempotent (NFC strings normalise to themselves), so it is safe
/// to leave in place permanently.
fn migrate_paths_to_nfc(connection: &Connection) -> Result<(), rusqlite::Error> {
    // Tables where file_path is the sole primary / unique key.
    let simple_tables = [
        "books",
        "notes",
        "viewer_preferences",
        "reading_positions",
        "external_books",
    ];

    for table in &simple_tables {
        let nfd_paths: Vec<String> = {
            let mut stmt = connection.prepare(&format!("SELECT file_path FROM {table}"))?;
            // `file_path` is nullable in some of these tables (e.g. the global
            // `viewer_preferences` row keys off `scope_key` and stores a NULL
            // path). A NULL path has nothing to NFC-normalize, so read it as
            // `Option<String>` and skip the NULLs — while still propagating a
            // genuine row-decode error rather than silently dropping the row.
            let all_paths: Vec<String> = stmt
                .query_map([], |row| row.get::<_, Option<String>>(0))?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .collect();
            all_paths
                .into_iter()
                .filter(|p| {
                    let nfc: String = p.nfc().collect();
                    nfc != *p
                })
                .collect()
        };

        for nfd in nfd_paths {
            let nfc: String = nfd.nfc().collect();
            let nfc_exists = connection
                .query_row(
                    &format!("SELECT 1 FROM {table} WHERE file_path = ?1"),
                    params![nfc],
                    |_| Ok(()),
                )
                .is_ok();

            if nfc_exists {
                // NFC row already exists (written by MCP or a later scan).
                // Drop the obsolete NFD duplicate.
                connection.execute(
                    &format!("DELETE FROM {table} WHERE file_path = ?1"),
                    params![nfd],
                )?;
            } else {
                if *table == "viewer_preferences" {
                    let scope_keys: Vec<String> = {
                        let mut stmt = connection.prepare(
                            "SELECT scope_key FROM viewer_preferences WHERE file_path = ?1",
                        )?;
                        let rows = stmt.query_map(params![&nfd], |row| row.get(0))?;
                        rows.collect::<Result<Vec<_>, _>>()?
                    };
                    for scope_key in scope_keys {
                        let next_scope_key = scope_key.replacen(&nfd, &nfc, 1);
                        connection.execute(
                            "UPDATE viewer_preferences SET file_path = ?1, scope_key = ?2 WHERE scope_key = ?3",
                            params![&nfc, &next_scope_key, &scope_key],
                        )?;
                    }
                } else {
                    connection.execute(
                        &format!("UPDATE {table} SET file_path = ?1 WHERE file_path = ?2"),
                        params![nfc, nfd],
                    )?;
                }
            }
        }
    }

    // book_tags has a compound primary key (file_path, tag).
    let nfd_tags: Vec<(String, String)> = {
        let mut stmt = connection.prepare("SELECT file_path, tag FROM book_tags")?;
        let all_tags: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        all_tags
            .into_iter()
            .filter(|(p, _)| {
                let nfc: String = p.nfc().collect();
                nfc != *p
            })
            .collect()
    };

    for (nfd, tag) in nfd_tags {
        let nfc: String = nfd.nfc().collect();
        connection.execute(
            "INSERT OR IGNORE INTO book_tags (file_path, tag) VALUES (?1, ?2)",
            params![nfc, tag],
        )?;
        connection.execute(
            "DELETE FROM book_tags WHERE file_path = ?1 AND tag = ?2",
            params![nfd, tag],
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use unicode_normalization::UnicodeNormalization;

    #[test]
    fn migrate_paths_to_nfc_tolerates_null_file_path() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                "
                CREATE TABLE books (file_path TEXT);
                CREATE TABLE notes (file_path TEXT);
                CREATE TABLE viewer_preferences (scope_key TEXT, file_path TEXT);
                CREATE TABLE reading_positions (file_path TEXT);
                CREATE TABLE external_books (file_path TEXT);
                CREATE TABLE book_tags (file_path TEXT, tag TEXT);
                ",
            )
            .expect("migration tables should be created");

        // Global viewer preferences are keyed only by `scope_key` and store a
        // NULL `file_path`. Reading that column as a non-optional `String`
        // previously aborted the startup setup hook (panic on `Invalid column
        // type Null`). The migration must skip NULL paths.
        connection
            .execute(
                "INSERT INTO viewer_preferences (scope_key, file_path) VALUES ('global::pdf', NULL)",
                [],
            )
            .expect("global pref row should insert");

        // A real NFD path alongside the NULL row, to confirm normalization of
        // non-NULL paths is unaffected.
        let nfd = "cafe\u{0301}.pdf";
        let nfc: String = nfd.nfc().collect();
        connection
            .execute(
                "INSERT INTO books (file_path) VALUES (?1)",
                rusqlite::params![nfd],
            )
            .expect("nfd book row should insert");

        migrate_paths_to_nfc(&connection).expect("migration should tolerate NULL file_path");

        let stored: String = connection
            .query_row("SELECT file_path FROM books", [], |row| row.get(0))
            .expect("book row should still exist");
        assert_eq!(stored, nfc, "non-NULL NFD path should be normalized to NFC");
    }

    #[test]
    fn migrate_paths_to_nfc_normalizes_book_tags() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                "
                CREATE TABLE books (file_path TEXT);
                CREATE TABLE notes (file_path TEXT);
                CREATE TABLE viewer_preferences (scope_key TEXT, file_path TEXT);
                CREATE TABLE reading_positions (file_path TEXT);
                CREATE TABLE external_books (file_path TEXT);
                CREATE TABLE book_tags (file_path TEXT, tag TEXT);
                ",
            )
            .expect("migration tables should be created");

        let nfd = "cafe\u{0301}.pdf";
        let nfc: String = nfd.nfc().collect();
        connection
            .execute(
                "INSERT INTO book_tags (file_path, tag) VALUES (?1, 'fiction')",
                rusqlite::params![nfd],
            )
            .expect("nfd tag row should insert");

        migrate_paths_to_nfc(&connection).expect("migration should run");

        let stored: String = connection
            .query_row("SELECT file_path FROM book_tags", [], |row| row.get(0))
            .expect("tag row should still exist");
        assert_eq!(
            stored, nfc,
            "book_tags file_path should be normalized to NFC"
        );
    }
}
