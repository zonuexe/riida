//! Multi-process body-extraction pool for full-text indexing.
//!
//! pdfium is not thread-safe; `pdfium-render`'s `thread_safe` feature
//! serializes every FFI call behind a process-wide mutex, so threads cannot
//! parallelize PDF text extraction. Separate *processes* can: each worker is
//! this same executable relaunched with [`WORKER_FLAG`], which loads its own
//! pdfium and answers extraction requests over a JSON-lines stdin/stdout
//! protocol.
//!
//! A side benefit is crash isolation: a pdfium segfault on a corrupt PDF kills
//! only the worker (the parent marks that file failed and respawns the
//! worker), not the whole app.
//!
//! The pool is used by the bulk index build/sync; the incremental save hooks
//! never extract bodies and stay in-process.

use crate::fulltext::ContentDoc;
use crate::fulltext_extract::{bind_pdfium, extract_epub_body, extract_pdf_body};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

/// CLI flag that switches the executable into extraction-worker mode. Checked
/// in `main()` before any Tauri initialization.
pub const WORKER_FLAG: &str = "--fulltext-extract-worker";

/// One extraction request sent to a worker (one JSON line on stdin).
#[derive(Debug, Serialize, Deserialize)]
pub struct ExtractRequest {
    pub file_path: String,
    pub title: String,
    /// `true` = PDF, `false` = EPUB (the only two body formats).
    pub is_pdf: bool,
    pub password: Option<String>,
}

/// One extraction result from a worker (one JSON line on stdout).
#[derive(Debug, Serialize, Deserialize)]
pub struct ExtractResponse {
    pub file_path: String,
    /// Body docs on success.
    pub docs: Vec<ContentDoc>,
    /// Extraction error message, if any (`docs` is empty then).
    pub error: Option<String>,
}

/// Entry point of a worker process: read requests line by line, extract, and
/// reply. Exits when stdin closes (parent dropped the pool) — the OS reclaims
/// everything, so no explicit shutdown message is needed.
pub fn worker_main(pdfium_dir: Option<&Path>) {
    let pdfium = bind_pdfium(pdfium_dir).ok();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        if line.is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<ExtractRequest>(&line) else {
            continue;
        };
        let result = if req.is_pdf {
            match &pdfium {
                Some(p) => extract_pdf_body(p, &req.file_path, &req.title, req.password.as_deref()),
                None => Err("pdfium unavailable in worker".to_owned()),
            }
        } else {
            extract_epub_body(&req.file_path, &req.title)
        };
        let response = match result {
            Ok(docs) => ExtractResponse {
                file_path: req.file_path,
                docs,
                error: None,
            },
            Err(e) => ExtractResponse {
                file_path: req.file_path,
                docs: Vec::new(),
                error: Some(e),
            },
        };
        let Ok(json) = serde_json::to_string(&response) else {
            continue;
        };
        if writeln!(stdout, "{json}")
            .and_then(|()| stdout.flush())
            .is_err()
        {
            break; // Parent went away.
        }
    }
}

/// Number of extraction workers: pdfium is the bottleneck at ~1 core per
/// process, and disk + memory pressure grow with each worker. Measured on real
/// data the build is extraction-bound, so a few workers give near-linear
/// speedup; beyond 4 the returns diminish.
pub fn default_worker_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get() / 2)
        .unwrap_or(2)
        .clamp(2, 4)
}

/// Spawn one worker child process.
fn spawn_worker(exe: &Path, pdfium_dir: Option<&PathBuf>) -> std::io::Result<Child> {
    let mut cmd = Command::new(exe);
    cmd.arg(WORKER_FLAG)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(dir) = pdfium_dir {
        cmd.env("PDFIUM_LIB_DIR", dir);
    }
    cmd.spawn()
}

/// Run body extraction for `requests` across `workers` child processes,
/// delivering each `ExtractResponse` to `results` as soon as it is ready
/// (work-stealing order, not input order). Returns the join handles' implicit
/// completion when all requests are answered; if a worker dies (e.g. pdfium
/// segfault), its in-flight file is reported as failed and the worker is
/// respawned for the remaining queue.
///
/// Falls back to reporting every request as failed if the executable cannot be
/// respawned at all (callers then degrade exactly like an extraction error).
pub fn run_extraction(
    requests: Vec<ExtractRequest>,
    workers: usize,
    pdfium_dir: Option<PathBuf>,
    results: Sender<ExtractResponse>,
) {
    let Ok(exe) = std::env::current_exe() else {
        fail_all(requests, &results, "current_exe unavailable");
        return;
    };
    let queue = Arc::new(Mutex::new(VecDeque::from(requests)));
    let workers = workers.max(1);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            let queue = Arc::clone(&queue);
            let results = results.clone();
            let exe = exe.clone();
            let pdfium_dir = pdfium_dir.clone();
            scope.spawn(move || {
                let mut child: Option<(Child, BufReader<std::process::ChildStdout>)> = None;
                loop {
                    let Some(req) = queue.lock().ok().and_then(|mut q| q.pop_front()) else {
                        break;
                    };
                    // (Re)spawn lazily so an idle pool costs nothing.
                    if child.is_none() {
                        match spawn_worker(&exe, pdfium_dir.as_ref()) {
                            Ok(mut c) => {
                                let stdout = c.stdout.take().expect("piped stdout");
                                child = Some((c, BufReader::new(stdout)));
                            }
                            Err(e) => {
                                let _ = results.send(ExtractResponse {
                                    file_path: req.file_path,
                                    docs: Vec::new(),
                                    error: Some(format!("spawn extract worker: {e}")),
                                });
                                continue;
                            }
                        }
                    }
                    let (c, reader) = child.as_mut().expect("worker just spawned");
                    match roundtrip(c, reader, &req) {
                        Ok(resp) => {
                            let _ = results.send(resp);
                        }
                        Err(e) => {
                            // Worker died mid-file (pdfium crash or pipe error):
                            // fail this file, drop the child, respawn for the next.
                            let _ = results.send(ExtractResponse {
                                file_path: req.file_path,
                                docs: Vec::new(),
                                error: Some(format!("extract worker failed: {e}")),
                            });
                            if let Some((mut c, _)) = child.take() {
                                let _ = c.kill();
                                let _ = c.wait();
                            }
                        }
                    }
                }
                // Closing stdin (drop) ends the worker's read loop.
                if let Some((mut c, _)) = child.take() {
                    drop(c.stdin.take());
                    let _ = c.wait();
                }
            });
        }
    });
}

/// Send one request and read one response line.
fn roundtrip(
    child: &mut Child,
    reader: &mut BufReader<std::process::ChildStdout>,
    req: &ExtractRequest,
) -> Result<ExtractResponse, String> {
    let stdin = child.stdin.as_mut().ok_or("worker stdin closed")?;
    let json = serde_json::to_string(req).map_err(|e| e.to_string())?;
    writeln!(stdin, "{json}")
        .and_then(|()| stdin.flush())
        .map_err(|e| format!("write request: {e}"))?;
    let mut line = String::new();
    let n = reader
        .read_line(&mut line)
        .map_err(|e| format!("read response: {e}"))?;
    if n == 0 {
        return Err("worker exited".to_owned());
    }
    serde_json::from_str(&line).map_err(|e| format!("parse response: {e}"))
}

fn fail_all(requests: Vec<ExtractRequest>, results: &Sender<ExtractResponse>, reason: &str) {
    for req in requests {
        let _ = results.send(ExtractResponse {
            file_path: req.file_path,
            docs: Vec::new(),
            error: Some(reason.to_owned()),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fulltext::ContentKind;

    #[test]
    fn request_and_response_round_trip_as_json_lines() {
        let req = ExtractRequest {
            file_path: "a.pdf".into(),
            title: "本".into(),
            is_pdf: true,
            password: Some("秘密".into()),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(!json.contains('\n'), "must fit one line");
        let back: ExtractRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(back.file_path, "a.pdf");
        assert_eq!(back.password.as_deref(), Some("秘密"));

        let resp = ExtractResponse {
            file_path: "a.pdf".into(),
            docs: vec![ContentDoc {
                file_path: "a.pdf".into(),
                kind: ContentKind::Body,
                title: "本".into(),
                authors: String::new(),
                tags: String::new(),
                text: "改行\nを含む本文".into(),
                loc_page: Some(3),
                loc_anchor: None,
            }],
            error: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(!json.contains('\n'), "newlines must be escaped");
        let back: ExtractResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(back.docs.len(), 1);
        assert_eq!(back.docs[0].text, "改行\nを含む本文");
        assert_eq!(back.docs[0].loc_page, Some(3));
    }

    #[test]
    fn default_worker_count_is_bounded() {
        let n = default_worker_count();
        assert!((2..=4).contains(&n));
    }
}
