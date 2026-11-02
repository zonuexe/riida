//! Per-book reading state: notes, reading positions, and PDF passwords.

use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDocument {
    pub file_path: String,
    pub format: String,
    pub content: String,
    pub updated_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPosition {
    pub file_path: String,
    pub page_number: u32,
    pub page_offset_ratio: f64,
    pub cfi: Option<String>,
    pub updated_at: Option<u64>,
}

pub fn normalize_page_offset_ratio(page_offset_ratio: f64) -> f64 {
    page_offset_ratio.clamp(0.0, 1.0)
}

pub fn query_pdf_password(
    connection: &Connection,
    file_path: &str,
) -> Result<Option<String>, String> {
    let result = connection.query_row(
        "SELECT password FROM pdf_passwords WHERE file_path = ?1",
        params![file_path],
        |row| row.get::<_, String>(0),
    );
    match result {
        Ok(password) => Ok(Some(password)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn upsert_pdf_password(
    connection: &Connection,
    file_path: &str,
    password: &str,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    connection
        .execute(
            "INSERT INTO pdf_passwords (file_path, password, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(file_path) DO UPDATE SET password = excluded.password, updated_at = excluded.updated_at",
            params![file_path, password, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::password_connection;

    #[test]
    fn pdf_password_returns_none_when_not_saved() {
        let connection = password_connection();
        let result = query_pdf_password(&connection, "/some/book.pdf");
        assert_eq!(result, Ok(None));
    }

    #[test]
    fn pdf_password_round_trips_after_save() {
        let connection = password_connection();
        upsert_pdf_password(&connection, "/some/book.pdf", "s3cr3t").expect("save should succeed");
        let result = query_pdf_password(&connection, "/some/book.pdf");
        assert_eq!(result, Ok(Some("s3cr3t".to_string())));
    }

    #[test]
    fn pdf_password_save_updates_existing_entry() {
        let connection = password_connection();
        upsert_pdf_password(&connection, "/some/book.pdf", "old_pass")
            .expect("first save should succeed");
        upsert_pdf_password(&connection, "/some/book.pdf", "new_pass")
            .expect("second save should succeed");
        let result = query_pdf_password(&connection, "/some/book.pdf");
        assert_eq!(result, Ok(Some("new_pass".to_string())));
    }

    #[test]
    fn pdf_password_is_scoped_to_file_path() {
        let connection = password_connection();
        upsert_pdf_password(&connection, "/books/a.pdf", "pass_a").expect("save should succeed");
        assert_eq!(
            query_pdf_password(&connection, "/books/a.pdf"),
            Ok(Some("pass_a".to_string()))
        );
        assert_eq!(query_pdf_password(&connection, "/books/b.pdf"), Ok(None));
    }
}
