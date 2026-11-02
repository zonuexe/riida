//! Editable book metadata and its validation.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMetadataPayload {
    pub file_path: String,
    pub title: String,
    pub authors: Vec<String>,
    pub description: String,
    pub publisher: String,
    pub release_date: String,
    pub language: String,
    pub url: String,
    pub asin: String,
    pub cover_url: String,
    pub updated_at: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMetadataInput {
    pub file_path: String,
    pub source_type: Option<String>,
    pub title: String,
    pub authors: Vec<String>,
    pub description: String,
    pub publisher: String,
    pub release_date: String,
    pub language: String,
    pub url: String,
    pub asin: String,
    pub cover_url: String,
}

fn normalize_book_metadata_authors(authors: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for author in authors {
        let trimmed = author.trim();
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

fn is_leap_year(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

fn is_valid_release_date(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return true;
    }

    let mut parts = trimmed.split('-');
    let Some(year) = parts.next() else {
        return false;
    };
    let Some(month) = parts.next() else {
        return false;
    };
    let Some(day) = parts.next() else {
        return false;
    };
    if parts.next().is_some() || year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return false;
    }

    let Ok(year) = year.parse::<u32>() else {
        return false;
    };
    let Ok(month) = month.parse::<u32>() else {
        return false;
    };
    let Ok(day) = day.parse::<u32>() else {
        return false;
    };

    // Months outside 1..=12 fall through the match's `_` arm below, so only the
    // day-zero case needs an explicit guard here.
    if day == 0 {
        return false;
    }

    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => return false,
    };

    day <= max_day
}

pub fn normalize_book_metadata(input: BookMetadataInput) -> Result<BookMetadataPayload, String> {
    let release_date = input.release_date.trim().to_string();
    if !is_valid_release_date(&release_date) {
        return Err("Release date must use YYYY-MM-DD.".to_string());
    }

    Ok(BookMetadataPayload {
        file_path: input.file_path,
        title: input.title.trim().to_string(),
        authors: normalize_book_metadata_authors(input.authors),
        description: input.description.trim().to_string(),
        publisher: input.publisher.trim().to_string(),
        release_date,
        language: input.language.trim().to_string(),
        url: input.url.trim().to_string(),
        asin: input.asin.trim().to_string(),
        cover_url: input.cover_url.trim().to_string(),
        updated_at: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::sample_metadata_input;

    #[test]
    fn normalize_book_metadata_authors_discards_empty_values_and_deduplicates() {
        let normalized = normalize_book_metadata_authors(vec![
            " Alice ".to_string(),
            "".to_string(),
            "Bob".to_string(),
            "Alice".to_string(),
        ]);

        assert_eq!(normalized, vec!["Alice", "Bob"]);
    }

    #[test]
    fn release_date_validation_accepts_empty_and_valid_dates() {
        assert!(is_valid_release_date(""));
        assert!(is_valid_release_date("2026-04-04"));
        assert!(is_valid_release_date("2024-02-29"));
    }

    #[test]
    fn release_date_validation_rejects_invalid_dates() {
        assert!(!is_valid_release_date("2026/04/04"));
        assert!(!is_valid_release_date("2026-02-29"));
        assert!(!is_valid_release_date("2026-13-01"));
        assert!(!is_valid_release_date("2026-04-31"));
    }

    #[test]
    fn release_date_validation_covers_boundaries() {
        // Each month-length arm plus the leap-year path, and month == 12.
        assert!(is_valid_release_date("2020-01-31"));
        assert!(is_valid_release_date("2020-04-30"));
        assert!(is_valid_release_date("2021-02-28"));
        assert!(is_valid_release_date("2020-02-29"));
        assert!(is_valid_release_date("2020-12-31"));

        // Each branch of the structural guard
        // (extra component / year / month / day length).
        assert!(!is_valid_release_date("2020-01-01-01"));
        assert!(!is_valid_release_date("202-01-01"));
        assert!(!is_valid_release_date("2020-1-01"));
        assert!(!is_valid_release_date("2020-01-1"));

        // Each branch of `month == 0 || month > 12 || day == 0`.
        assert!(!is_valid_release_date("2020-00-01"));
        assert!(!is_valid_release_date("2020-13-01"));
        assert!(!is_valid_release_date("2020-01-00"));

        // Day exceeds the month length.
        assert!(!is_valid_release_date("2020-02-30"));
        assert!(!is_valid_release_date("2021-02-29"));
    }

    #[test]
    fn normalize_book_metadata_validates_and_trims() {
        let ok =
            normalize_book_metadata(sample_metadata_input(" 2021-07-15 ")).expect("valid date");
        assert_eq!(ok.release_date, "2021-07-15");
        assert_eq!(ok.title, "Title");
        assert!(normalize_book_metadata(sample_metadata_input("2021-13-01")).is_err());
    }
}
