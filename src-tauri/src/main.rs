// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Full-text extraction worker mode: the bulk indexer relaunches this same
    // executable per worker (pdfium cannot parallelize within one process).
    // Must be checked before any Tauri initialization.
    if std::env::args().any(|a| a == riida_lib::fulltext_pool::WORKER_FLAG) {
        riida_lib::fulltext_pool::worker_main(None);
        return;
    }
    riida_lib::run()
}
