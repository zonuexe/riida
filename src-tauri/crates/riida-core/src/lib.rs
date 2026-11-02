//! Frontend-independent core of riida: everything that does not need Tauri or
//! the app's process-wide state. The Tauri crate wraps these in commands.

pub mod epub_image;
pub mod fulltext;
pub mod fulltext_extract;
pub mod fulltext_pool;
