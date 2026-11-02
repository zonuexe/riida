//! Frontend-independent core of riida: everything that does not need Tauri or
//! the app's process-wide state. The Tauri crate wraps these in commands.

pub mod config;
pub mod db;
pub mod epub;
pub mod epub_image;
pub mod fulltext;
pub mod fulltext_books;
pub mod fulltext_extract;
pub mod fulltext_pool;
pub mod library;
pub mod metadata;
pub mod reading;
pub mod storage;
pub mod tags;
pub mod thumbnail;
pub mod viewer_prefs;

#[cfg(test)]
mod test_support;
