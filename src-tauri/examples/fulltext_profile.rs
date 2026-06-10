//! Profiling harness for the full-text index (extraction + indexing + search).
//!
//! Runs the same core code paths as `run_fulltext_build` against real library
//! files, with per-phase timing, so indexing strategies can be compared:
//!
//! ```bash
//! cargo build --profile profiling --example fulltext_profile
//! target/profiling/examples/fulltext_profile \
//!   --root ~/Dropbox/EBook --limit 100 --mode per-book
//! ```
//!
//! Online-only (dataless) cloud placeholders are always skipped so profiling
//! never forces a download. Std-only; no extra dependencies.

use riida_lib::fulltext::{ContentDoc, FullTextIndex};
use riida_lib::fulltext_extract::{bind_pdfium, extract_epub_body, extract_pdf_body};
use riida_lib::fulltext_pool::{run_extraction, worker_main, ExtractRequest, WORKER_FLAG};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// One `index_docs` call (writer + commit + reload) per book — mirrors the
    /// current `run_fulltext_build` behavior.
    PerBook,
    /// One `index_docs` call per N books.
    Chunked(usize),
    /// A single `index_docs` call for the whole sample.
    Batched,
}

struct Args {
    root: PathBuf,
    limit: usize,
    index_dir: PathBuf,
    mode: Mode,
    max_file_mb: u64,
    keep_index: bool,
    search_only: bool,
    update_bench: bool,
    consolidate: bool,
    /// 0 = in-process serial extraction; N = N extraction worker processes.
    workers: usize,
}

fn parse_args() -> Args {
    let mut args = Args {
        root: PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Dropbox/EBook"),
        limit: 100,
        index_dir: std::env::temp_dir().join("riida-fulltext-profile"),
        mode: Mode::PerBook,
        max_file_mb: u64::MAX,
        keep_index: false,
        search_only: false,
        update_bench: false,
        consolidate: false,
        workers: 0,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let mut val = || it.next().expect("missing value for flag");
        match a.as_str() {
            "--root" => args.root = PathBuf::from(val()),
            "--limit" => args.limit = val().parse().expect("bad --limit"),
            "--index-dir" => args.index_dir = PathBuf::from(val()),
            "--mode" => {
                args.mode = match val().as_str() {
                    "per-book" => Mode::PerBook,
                    "batched" => Mode::Batched,
                    m => {
                        let n = m
                            .strip_prefix("chunked:")
                            .and_then(|n| n.parse().ok())
                            .expect("bad --mode (per-book | batched | chunked:N)");
                        Mode::Chunked(n)
                    }
                }
            }
            "--max-file-mb" => args.max_file_mb = val().parse().expect("bad --max-file-mb"),
            "--keep-index" => args.keep_index = true,
            "--search-only" => args.search_only = true,
            "--update-bench" => args.update_bench = true,
            "--consolidate" => args.consolidate = true,
            "--workers" => args.workers = val().parse().expect("bad --workers"),
            other => panic!("unknown flag: {other}"),
        }
    }
    args
}

/// Online-only cloud placeholder: non-empty file with zero allocated blocks.
/// (Same rule as `is_dataless` in lib.rs, which is private to the app crate.)
fn is_dataless(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    meta.len() > 0 && meta.blocks() == 0
}

struct Candidate {
    path: PathBuf,
    size: u64,
    is_pdf: bool,
}

/// Walk `root` for local (non-dataless) PDFs/EPUBs, sorted by path, then take a
/// deterministic stride sample of `limit` files so the sample spreads across
/// publishers/directories instead of clustering in the first folder.
fn discover(root: &Path, limit: usize, max_file_mb: u64) -> Vec<Candidate> {
    fn walk(dir: &Path, out: &mut Vec<Candidate>, max_bytes: u64) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                walk(&path, out, max_bytes);
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase);
            let is_pdf = match ext.as_deref() {
                Some("pdf") => true,
                Some("epub") => false,
                _ => continue,
            };
            if is_dataless(&meta) || meta.len() > max_bytes {
                continue;
            }
            out.push(Candidate {
                path,
                size: meta.len(),
                is_pdf,
            });
        }
    }
    let mut all = Vec::new();
    walk(root, &mut all, max_file_mb.saturating_mul(1024 * 1024));
    all.sort_by(|a, b| a.path.cmp(&b.path));
    if all.len() <= limit {
        return all;
    }
    let stride = all.len() as f64 / limit as f64;
    (0..limit)
        .map(|i| (i as f64 * stride) as usize)
        .map(|idx| {
            let c = &all[idx];
            Candidate {
                path: c.path.clone(),
                size: c.size,
                is_pdf: c.is_pdf,
            }
        })
        .collect()
}

struct ExtractStat {
    path: String,
    size: u64,
    is_pdf: bool,
    units: usize,
    text_bytes: usize,
    extract: Duration,
    index: Duration,
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}

fn fmt_dur(d: Duration) -> String {
    if d.as_secs_f64() >= 1.0 {
        format!("{:.2}s", d.as_secs_f64())
    } else {
        format!("{:.1}ms", d.as_secs_f64() * 1000.0)
    }
}

fn dir_size(dir: &Path) -> u64 {
    fn rec(dir: &Path, acc: &mut u64) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                rec(&entry.path(), acc);
            } else {
                *acc += meta.len();
            }
        }
    }
    let mut acc = 0;
    rec(dir, &mut acc);
    acc
}

const SEARCH_QUERIES: &[&str] = &[
    "検索",
    "プログラミング",
    "Emacs",
    "スクラム",
    "関数型",
    "データベース",
    "正規表現",
    "アルゴリズム",
    "rust",
    "オブジェクト指向 設計",
];

fn bench_search(index: &FullTextIndex) {
    println!("\n== search latency (limit=50, 20 iterations each) ==");
    println!(
        "{:<28} {:>6} {:>10} {:>10} {:>10}",
        "query", "hits", "p50", "p95", "max"
    );
    for q in SEARCH_QUERIES {
        // Warm-up.
        for _ in 0..3 {
            let _ = index.search(q, 50);
        }
        let mut times = Vec::with_capacity(20);
        let mut hits = 0;
        for _ in 0..20 {
            let t = Instant::now();
            let r = index.search(q, 50).expect("search failed");
            times.push(t.elapsed());
            hits = r.len();
        }
        times.sort();
        println!(
            "{:<28} {:>6} {:>10} {:>10} {:>10}",
            q,
            hits,
            fmt_dur(percentile(&times, 0.5)),
            fmt_dur(percentile(&times, 0.95)),
            fmt_dur(*times.last().unwrap()),
        );
    }
}

/// Cost of the incremental save hooks: a single-doc `index_docs` (note saved)
/// and a `delete_kind` (note cleared), measured against an existing index.
fn bench_update(index: &FullTextIndex) {
    println!("\n== single-doc update latency (note-save hook cost) ==");
    let mut times = Vec::new();
    for i in 0..10 {
        let doc = ContentDoc {
            file_path: "update-bench.pdf".into(),
            kind: riida_lib::fulltext::ContentKind::Note,
            title: "update bench".into(),
            authors: String::new(),
            tags: String::new(),
            text: format!("更新ベンチマークのメモ本文 その{i}"),
            loc_page: None,
            loc_anchor: None,
        };
        let t = Instant::now();
        index.index_docs(&[doc]).expect("index_docs");
        times.push(t.elapsed());
    }
    times.sort();
    println!(
        "index_docs(1 doc): p50 {}  min {}  max {}",
        fmt_dur(percentile(&times, 0.5)),
        fmt_dur(times[0]),
        fmt_dur(*times.last().unwrap())
    );
    let mut times = Vec::new();
    for _ in 0..5 {
        let t = Instant::now();
        index
            .delete_kind("update-bench.pdf", riida_lib::fulltext::ContentKind::Note)
            .expect("delete_kind");
        times.push(t.elapsed());
    }
    times.sort();
    println!(
        "delete_kind:       p50 {}  min {}  max {}",
        fmt_dur(percentile(&times, 0.5)),
        fmt_dur(times[0]),
        fmt_dur(*times.last().unwrap())
    );
}

/// Pipelined build: extraction runs in `workers` child processes while this
/// (main) thread chunk-indexes results as they arrive.
fn run_with_workers(args: &Args, index: &FullTextIndex, candidates: &[Candidate]) {
    let chunk_books = match args.mode {
        Mode::Chunked(n) => n,
        _ => 32,
    };
    let requests: Vec<ExtractRequest> = candidates
        .iter()
        .map(|c| ExtractRequest {
            file_path: c.path.to_string_lossy().into_owned(),
            title: c
                .path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            is_pdf: c.is_pdf,
            password: None,
        })
        .collect();
    let total = requests.len();
    let sample_bytes: u64 = candidates.iter().map(|c| c.size).sum();

    let t_total = Instant::now();
    let (tx, rx) = std::sync::mpsc::channel();
    let workers = args.workers;
    let pdfium_dir = std::env::var("PDFIUM_LIB_DIR").ok().map(PathBuf::from);
    let producer = std::thread::spawn(move || run_extraction(requests, workers, pdfium_dir, tx));

    let mut pending: Vec<ContentDoc> = Vec::new();
    let mut pending_books = 0usize;
    let mut index_total = Duration::ZERO;
    let mut failed = 0usize;
    let mut done = 0usize;
    let mut units_total = 0usize;
    let mut text_total = 0usize;

    for resp in rx {
        done += 1;
        if let Some(e) = &resp.error {
            failed += 1;
            eprintln!("  extract failed: {}: {e}", resp.file_path);
        }
        units_total += resp.docs.len();
        text_total += resp.docs.iter().map(|d| d.text.len()).sum::<usize>();
        pending.extend(resp.docs);
        pending_books += 1;
        if pending_books >= chunk_books {
            let t = Instant::now();
            index.index_docs(&pending).expect("index_docs");
            index_total += t.elapsed();
            pending.clear();
            pending_books = 0;
        }
        if done.is_multiple_of(10) {
            eprintln!("  …{done}/{total}");
        }
    }
    if !pending.is_empty() {
        let t = Instant::now();
        index.index_docs(&pending).expect("index_docs (final)");
        index_total += t.elapsed();
    }
    producer.join().expect("extraction producer");
    let t = Instant::now();
    index.consolidate().expect("consolidate");
    let consolidate_time = t.elapsed();
    let total_wall = t_total.elapsed();

    println!("\n== build profile (workers={workers}, chunk={chunk_books}) ==");
    println!(
        "files ok={} failed={failed}  units(docs)={units_total}  extracted text={:.1} MB",
        total - failed,
        text_total as f64 / 1e6
    );
    println!(
        "index (main thread): {}  consolidate: {}  total wall: {}",
        fmt_dur(index_total),
        fmt_dur(consolidate_time),
        fmt_dur(total_wall)
    );
    println!(
        "throughput: {:.1} files/min, {:.2} MB source/s end-to-end",
        total as f64 / total_wall.as_secs_f64() * 60.0,
        sample_bytes as f64 / 1e6 / total_wall.as_secs_f64()
    );
    println!(
        "index size on disk: {:.1} MB",
        dir_size(&args.index_dir) as f64 / 1e6
    );
}

fn main() {
    if std::env::args().any(|a| a == WORKER_FLAG) {
        worker_main(None);
        return;
    }
    let args = parse_args();

    if args.search_only || args.update_bench || args.consolidate {
        let t = Instant::now();
        let index = FullTextIndex::open_or_create(&args.index_dir).expect("open index");
        println!("opened index in {}", fmt_dur(t.elapsed()));
        if args.consolidate {
            println!(
                "index size before consolidate: {:.1} MB",
                dir_size(&args.index_dir) as f64 / 1e6
            );
            let t = Instant::now();
            index.consolidate().expect("consolidate");
            println!(
                "consolidate: {}  size after: {:.1} MB",
                fmt_dur(t.elapsed()),
                dir_size(&args.index_dir) as f64 / 1e6
            );
        }
        if args.update_bench {
            bench_update(&index);
        }
        if args.search_only {
            bench_search(&index);
        }
        return;
    }

    // Fresh index dir per run so strategies are comparable.
    let _ = std::fs::remove_dir_all(&args.index_dir);

    let t_total = Instant::now();
    let t = Instant::now();
    let candidates = discover(&args.root, args.limit, args.max_file_mb);
    let discover_time = t.elapsed();
    let sample_bytes: u64 = candidates.iter().map(|c| c.size).sum();
    println!(
        "discovered sample: {} files ({} pdf, {} epub), {:.2} GB in {}",
        candidates.len(),
        candidates.iter().filter(|c| c.is_pdf).count(),
        candidates.iter().filter(|c| !c.is_pdf).count(),
        sample_bytes as f64 / 1e9,
        fmt_dur(discover_time)
    );

    let t = Instant::now();
    let index = FullTextIndex::open_or_create(&args.index_dir).expect("open index");
    println!(
        "index open (incl. tokenizer load): {}",
        fmt_dur(t.elapsed())
    );

    if args.workers > 0 {
        run_with_workers(&args, &index, &candidates);
        bench_search(&index);
        if !args.keep_index {
            let _ = std::fs::remove_dir_all(&args.index_dir);
        } else {
            println!("\nindex kept at {}", args.index_dir.display());
        }
        return;
    }

    let t = Instant::now();
    let pdfium = bind_pdfium(None).expect("bind pdfium (set PDFIUM_LIB_DIR)");
    println!("pdfium bind: {}", fmt_dur(t.elapsed()));

    let mut stats: Vec<ExtractStat> = Vec::with_capacity(candidates.len());
    let mut extract_total = Duration::ZERO;
    let mut index_total = Duration::ZERO;
    let mut failed = 0usize;
    let mut pending: Vec<ContentDoc> = Vec::new();
    let mut pending_books = 0usize;

    for (i, c) in candidates.iter().enumerate() {
        let path = c.path.to_string_lossy().into_owned();
        let title = c
            .path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();

        let t = Instant::now();
        let docs = if c.is_pdf {
            extract_pdf_body(&pdfium, &path, &title, None)
        } else {
            extract_epub_body(&path, &title)
        };
        let extract = t.elapsed();
        extract_total += extract;

        let docs = match docs {
            Ok(d) => d,
            Err(e) => {
                failed += 1;
                eprintln!("  extract failed: {path}: {e}");
                continue;
            }
        };
        let units = docs.len();
        let text_bytes: usize = docs.iter().map(|d| d.text.len()).sum();

        let mut index_time = Duration::ZERO;
        match args.mode {
            Mode::PerBook => {
                let t = Instant::now();
                index.index_docs(&docs).expect("index_docs");
                index_time = t.elapsed();
            }
            Mode::Chunked(n) => {
                pending.extend(docs);
                pending_books += 1;
                if pending_books >= n {
                    let t = Instant::now();
                    index.index_docs(&pending).expect("index_docs");
                    index_time = t.elapsed();
                    pending.clear();
                    pending_books = 0;
                }
            }
            Mode::Batched => pending.extend(docs),
        }
        index_total += index_time;

        stats.push(ExtractStat {
            path,
            size: c.size,
            is_pdf: c.is_pdf,
            units,
            text_bytes,
            extract,
            index: index_time,
        });
        if (i + 1).is_multiple_of(10) {
            eprintln!(
                "  …{}/{} extracted={} indexed={}",
                i + 1,
                candidates.len(),
                fmt_dur(extract_total),
                fmt_dur(index_total)
            );
        }
    }

    if !pending.is_empty() {
        let t = Instant::now();
        index
            .index_docs(&pending)
            .expect("index_docs (final batch)");
        index_total += t.elapsed();
    }
    // Mirror the production build: run pending merges to completion so the
    // index ends compact (per-chunk writers abort their merges on drop).
    let t = Instant::now();
    index.consolidate().expect("consolidate");
    let consolidate_time = t.elapsed();

    let total = t_total.elapsed();
    let mode_name = match args.mode {
        Mode::PerBook => "per-book".to_owned(),
        Mode::Chunked(n) => format!("chunked:{n}"),
        Mode::Batched => "batched".to_owned(),
    };

    let total_units: usize = stats.iter().map(|s| s.units).sum();
    let total_text: usize = stats.iter().map(|s| s.text_bytes).sum();
    println!("\n== build profile (mode={mode_name}) ==");
    println!(
        "files ok={} failed={}  units(docs)={}  extracted text={:.1} MB",
        stats.len(),
        failed,
        total_units,
        total_text as f64 / 1e6
    );
    println!(
        "extract: {}  index: {}  consolidate: {}  total wall: {}",
        fmt_dur(extract_total),
        fmt_dur(index_total),
        fmt_dur(consolidate_time),
        fmt_dur(total)
    );
    println!(
        "throughput: {:.1} files/min, {:.2} MB source/s extract",
        stats.len() as f64 / total.as_secs_f64() * 60.0,
        sample_bytes as f64 / 1e6 / extract_total.as_secs_f64().max(0.001)
    );
    println!(
        "index size on disk: {:.1} MB",
        dir_size(&args.index_dir) as f64 / 1e6
    );

    let mut by_extract: Vec<&ExtractStat> = stats.iter().collect();
    by_extract.sort_by_key(|s| std::cmp::Reverse(s.extract));
    println!("\nslowest extractions:");
    for s in by_extract.iter().take(10) {
        println!(
            "  {:>8} {:>9} {:>5} units {:>7.1}MB src  {}",
            fmt_dur(s.extract),
            if s.is_pdf { "pdf" } else { "epub" },
            s.units,
            s.size as f64 / 1e6,
            s.path.rsplit('/').next().unwrap_or(&s.path)
        );
    }

    if args.mode == Mode::PerBook {
        let mut by_index: Vec<&ExtractStat> = stats.iter().collect();
        by_index.sort_by_key(|s| std::cmp::Reverse(s.index));
        println!("\nslowest per-book index_docs calls:");
        for s in by_index.iter().take(5) {
            println!(
                "  {:>8} {:>5} units  {}",
                fmt_dur(s.index),
                s.units,
                s.path.rsplit('/').next().unwrap_or(&s.path)
            );
        }
    }

    bench_search(&index);

    if !args.keep_index {
        let _ = std::fs::remove_dir_all(&args.index_dir);
    } else {
        println!("\nindex kept at {}", args.index_dir.display());
    }
}
