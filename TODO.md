# TODO

## EPUB ビューア

詳細・設計指針は [docs/epub.md](docs/epub.md) を参照。

### 高優先度

- [x] 内部 `#anchor` リンクをページ番号ジャンプへ置換してレイアウト破壊を回避
  - `book.locations.cfiFromHref(href)` で CFI を取得し `rendition.display(cfi)` に置き換える
  - epub.js の `replaceLinks` より前に処理する必要あり
- [x] 固定レイアウト (pre-paginated) を OPF から検出して `flow`/`spread` を切り替え
- [x] 外部リンク (`https://`, `mailto:`) を Tauri Rust 側の `on_navigation` ハンドラで開く
  - クロスフレーム JS では解決できないことが確認済み（AGENTS.md 参照）

### 中優先度

- [x] EPUB カバー画像をサムネイルとして抽出・表示
  - OPF `<item properties="cover-image">` → `cover.jpg` → fallback の順で探す
- [x] `-epub-writing-mode` 優先の注入 CSS（WKWebView の `-webkit-` 上書き対策）
- [x] body `padding`/`margin` をゼロにリセット（epub.js のデフォルト注入抑制）
- [x] `page-progression-direction` を読んで RTL 書籍の左右キーを反転

### 低優先度

- [ ] EPUB メタデータ自動取込（複数 `<dc:creator>` + `opf:role` 対応）
- [ ] 画像タップでオーバーレイ拡大表示（EPUB / PDF 両対応）
- [ ] EPUB 内 WebP 画像のキャッシュ・処理パイプライン対応

---

## 全般

- [ ] macOS 以外でのサムネイル生成（`qlmanage`/`sips` 非依存の代替手段）
- [ ] Windows / Linux でのクロスプラットフォーム動作確認
