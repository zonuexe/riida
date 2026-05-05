# PDF 処理メモ

このドキュメントは riida の PDF サポートのうち、**pdf.js を素のまま使うだけ
では成立しない** プロジェクト独自の処理についてまとめたものです。一般的な
pdf.js 使用法（`getDocument` の呼び出し方や TextLayer の使い方そのもの）は
扱いません。

レンダリング経路は 2 系統あります:

- **`pdfjs`**: 自前で組んだ pdf.js ベースのビューア。本ドキュメントが扱う
  対象はほぼここ。
- **`native`**: `<iframe>` に PDF を直接読ませて WebView ネイティブの
  PDF ビューアに任せる経路。設定項目を持つだけで、特別な処理は無い。

設定 `pdf_renderer` で切替。`pdfjs` がデフォルトです。

[src/main.ts](../src/main.ts) と [src/styles.css](../src/styles.css) が
本体。検出系・レイアウト系・検索系・リンク解決系は
`src/pdf-*.ts` の helper module 群に切り出してテストしています。

---

## TauriBinaryDataFactory: CMap / 標準フォントの読み込み

### 問題

pdf.js の `DOMBinaryDataFactory` は内部で `fetchData()` 経由でリソースを
取りに行きますが、その先には `isValidFetchUrl()` という **`http(s):` のみ
許可するハードコードのアロー リスト** があります。Tauri 2 macOS 製品ビルド
ではドキュメントが `tauri://localhost` から提供されるため、相対 URL は
`tauri:` スキームに解決され、pdf.js の許可リストを通れません。
そして XHR 系のフォールバック実装は `tauri:` を **silent に空ボディで成功**
させてしまうので、CMap や標準フォントが「読めたが 0 バイト」状態になります。

実害として、Adobe-Japan1 などの非埋め込み CJK フォントで CID → Unicode
マッピングが効かず、生 CID が canvas に描画されて文字化けします。

### 対処

[src/main.ts](../src/main.ts) の `TauriBinaryDataFactory` クラスで
`BinaryDataFactory` API を上書き。`fetch()` を直接呼ぶことで `tauri:` URL
でも実体を取得できるようになります。pdf.js の `getDocument` 呼び出しに
`BinaryDataFactory: TauriBinaryDataFactory` を渡しているのはこのため。

CMap / 標準フォントの実体は `node_modules/pdfjs-dist/{cmaps,standard_fonts}`
を [vite.config.ts](../vite.config.ts) で `dist/pdfjs/{cmaps,standard_fonts}/...`
にコピーしています。

---

## ReadableStream の async iteration が WKWebView で動かない

### 問題

pdf.js 5.6 の `PDFPageProxy.getTextContent`（`pdf.mjs:15294` 付近）は
内部の `streamTextContent()` が返す `ReadableStream` を `for await ... of`
で消費します。

ところが Tauri の WKWebView (macOS) は
`ReadableStream[Symbol.asyncIterator]` を実装していません。よって
`getTextContent()` を呼ぶと "undefined is not a function" が throw され、
**ストリームから 1 件も読み出せません**。

ハマりどころとして、pdf.js 標準の `TextLayer` クラスは内部で `getReader()`
を直接使うのでこのバグを踏まず、画面表示は普通に動きます。検出のように
`getTextContent()` を直接呼ぶ独自処理だけが silent に失敗します。

### 対処

[src/pdf-binding-detect.ts](../src/pdf-binding-detect.ts) の
`readPageTextContentForBinding(page)` で `streamTextContent()` を直接呼び、
`reader.read()` ループで items / styles を集約します。
`streamTextContent` が無い実装向けに `getTextContent` フォールバックも保持。

このワークアラウンドは
[src/pdf-binding-detect.test.ts](../src/pdf-binding-detect.test.ts) に
**「`Symbol.asyncIterator` を `undefined` にしたストリームでも読める」**
という回帰ガード付きで unit test を書いてあります。`for await` 系に戻すと
そのテストが落ちます。

---

## Text Layer の縦書き: pdf.js リファレンス CSS の取り込み

### 問題

pdf.js の `TextLayer` は各 `<span>` に `--font-height` / `--scale-x` /
`--rotate` を `style.setProperty` でセットしますが、それらを実際の
`font-size` や `transform` に展開する CSS は pdf.js 自身からは出力されず、
インテグレーター側で書く必要があります。

縦書き CMap (`*-V` 系) のフォントを使った PDF では pdf.js が
`style.vertical = true` を見て `--rotate: 90deg` を仕込みますが、
それを受け取る CSS が無いと span は回転されないまま絶対座標に置かれ、
**透明テキストレイヤーがビジュアルと一致せず、選択ハイライトが横方向の
帯としてバラバラに表示** されます。Acrobat や macOS Preview では
正しく縦の列として選択できる PDF でもこの現象が出ます。

### 対処

[src/styles.css](../src/styles.css) の `.pdfjs-viewer .textLayer` ブロックで
pdf.js リファレンスの textLayer 用 CSS を取り込みました:

```css
.pdfjs-viewer .textLayer {
  --total-scale-factor: var(--scale-factor, 1);
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}
.pdfjs-viewer .textLayer > :not(.markedContent),
.pdfjs-viewer .textLayer .markedContent span:not(.markedContent) {
  --font-height: 0;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1;
  --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}
.pdfjs-viewer .textLayer .markedContent { display: contents; }
```

`--scale-factor` はレンダ時に `pdfjsViewerEl.style.setProperty(
"--scale-factor", String(baseScale))` で書き込んでいます。

---

## 綴じ方向 (binding direction) の自動判定

### 設計

`bindingDirection` は `"left" | "right" | "auto"` の三値プリファレンス。
既定は `"auto"`。

- `"left"` / `"right"`: ユーザー明示。レンダ時はそのまま採用。検出をスキップ。
- `"auto"`: 描画前に検出を走らせ、結果に応じて `"left"` / `"right"` を決定。
  検出が判定不能なら `"left"` にフォールバック。

検出は `tauri::Builder::setup` の段階での 1 回限りのマイグレーションで、
旧バージョンの保存値 `"left"`（旧デフォルト）も `"auto"` に昇格させます
（[Rust 側の TOML version stamp](#tomlversion-とマイグレーションスキーム)
を参照）。

### 検出ヒューリスティック (3 段)

[src/pdf-binding-detect.ts](../src/pdf-binding-detect.ts) で実装。
信頼度の高い順に評価し、最初にヒットしたものを採用します。

1. **`/ViewerPreferences /Direction`**
   PDF カタログの ViewerPreferences 辞書を `pdfDocument.getViewerPreferences()`
   経由で読む。`R2L` → 右綴じ、`L2R` → 左綴じ。InDesign が日本語書籍書き出し
   時に明示的に出すケースなど、これが付いている PDF はこの一発で確定。

2. **縦書き CMap (style.vertical)**
   各サンプルページの `getTextContent()` の `styles[fontName].vertical`
   を集計。`90ms-RKSJ-V` / `UniJIS-UTF16-V` 等の縦書き CIDFont エンコーディング
   を持つフォントは `vertical: true` で出てくる。一定文字数以上、かつ縦書き
   フォントの文字数が閾値以上なら右綴じ。

3. **テキストアイテムのジオメトリ**
   多くの組版済み日本語 PDF は `/Identity-H`（横書き CMap）を使いつつ、
   各グリフを個別配置で縦に積み上げる「手組みの縦書き」を採ります。この
   場合 `style.vertical` は `false` のままです。
   そこで text-item の `transform[4]` (tx) と `transform[5]` (ty) の
   隣接アイテム間 |Δ| を累積し、`Σ|Δy| / Σ|Δx| ≥ 1.2` のように Y 軸方向
   の動きが支配的なら右綴じと判定。`Δx === 0` (純粋に縦移動だけの場合) は
   ゼロ除算を避けて自動的に縦と判定。

サンプリングは線形に最大 50 ページまで。スパースな本の本文がフロントマター
の後ろにある PDF（前付け 30 ページ → 本文）でも信号を拾えます。
描画キャンセルトークン (`isCancelled()`) を渡しているので、ユーザーが
途中で別の本に移動した時にスキャンを中断できます。

純粋な画像 PDF（テキストレイヤー無し）は原理的に判定不能で、フォールバック
で `"left"` になります。ユーザーは設定パネルで個別にファイルスコープの
`"right"` を保存できます。

---

## レンダーウィンドウ planner (仮想スクロール)

PDF が数百ページに及ぶことは普通なので、全ページを一度に DOM に入れず
**現在表示中のページから半径 N の範囲だけ描画 / さらに広い範囲だけ DOM 保持**
というウィンドウ方式を取っています。

[src/pdf-render-window-utils.ts](../src/pdf-render-window-utils.ts) の
`buildPdfRenderWindowPlan(totalGroups, activeGroupIndex, renderRadius, keepRadius)`
が pure helper で:

- `renderMin..renderMax`: canvas を描画するインデックス範囲
- `keepMin..keepMax`: DOM placeholder を保持する範囲（外に出たら捨てる）
- `renderOrder`: アクティブ → 近距離前 → 近距離後 → ... の順序

を返します。テストは
[src/pdf-render-window-utils.test.ts](../src/pdf-render-window-utils.test.ts)。

スクロール時に `schedulePdfRenderWindowUpdate(session, focusGroupIndex?)`
が新しいウィンドウを計算し、外に出た plan は `releasePdfRenderPlan` で
canvas / textLayer を廃棄します。

---

## 見開き (spread) レイアウトと visualPageOrder

[src/viewer-layout-utils.ts](../src/viewer-layout-utils.ts) の
`buildPageGroups` と `getVisualPageOrder` で見開きグルーピングを決めます。

- `pageMode = "spread"` なら 2 ページ単位、`treatFirstPageAsCover` が真なら
  最初のページを単独カバーとして扱う。
- `bindingDirection = "right"` のときは各 2 ページ群を視覚的に逆順
  (`[a, b] → [b, a]`) して右綴じレイアウトに合わせる。
- `fit-height + spread` の場合、見開き合成の幅がビューア幅を超える
  ページ群は単ページに分割するロジックがレンダ側にある (`layoutGroups`)。

これらの関数は `bindingDirection: "left" | "right"` だけを受けるので、
`"auto"` は **render 時に解決済みの値** を渡しています。
解決済み値は `PdfRenderSession.resolvedBindingDirection` にキャッシュし、
キーボードナビゲーションからも参照されます。

---

## ページ単位キーボードナビゲーション

[src/pdf-paged-nav-utils.ts](../src/pdf-paged-nav-utils.ts) の
`planPagedKeyAction` で、`scrollMode = "paged"` 時の矢印キー / PageUp /
PageDown のスクロール行動を pure に計算します。

ページ内をまだスクロールできるなら 1 画面ぶん移動、ページ端に達していたら
隣のページへジャンプ、左右矢印は綴じ方向に応じて意味が反転、など。

---

## 検索: 正規化と CJK 部首マッピング

[src/pdf-search-utils.ts](../src/pdf-search-utils.ts) の `searchNormalize`:

1. NFD で結合文字を分離 → コンバイニングマークを剥がす（`ñ` ↔ `n`）
2. NFKC で半角/全角を統一（半角カナ ↔ 全角カナ）
3. lowercase
4. CJK 部首ブロック (U+2E80..U+2EFF, U+2F00..U+2FDF) を
   [src/cjk-radical-map.ts](../src/cjk-radical-map.ts) で正規漢字に置換

正規化文字列のインデックスから元の `(itemIndex, origOffset, origOffsetEnd)`
を引けるよう並列配列 (`normChars`) を持ち、ヒットしたら DOM 上の
text span にハイライトを再構築します。

ページ単位に lazy build (`ensurePdfSearchPageIndex(pageNumber)`)。

---

## 内部リンク解決

[src/pdf-link-utils.ts](../src/pdf-link-utils.ts) の `resolvePdfLinkTarget`
が pdf.js の annotation オブジェクトを以下に解決:

- 名前付きデスティネーション (`destination` が文字列の場合は
  `getDestination()` で展開)
- 明示デスティネーション配列 (1 番目に page ref か page index)
- Named action (`NextPage` / `PrevPage` / `FirstPage` / `LastPage`)
- 外部 URL (`url` フィールド) と `#page=N` 形式の URL ハッシュ

戻り値は `{ type: "internal", pageNumber }` または
`{ type: "external", url }`。

---

## 読書位置の保存と復元

`{ pageNumber, pageOffsetRatio }` で表現します
([src/reading-position-utils.ts](../src/reading-position-utils.ts))。
`pageOffsetRatio` はそのページ内での縦方向の進捗 (0..1)。

- `localStorage` に即時キャッシュ (`riida:reading-position:<filePath>`)
- SQLite にも書き戻し (debounced)
- ページ DOM 構築時にプレースホルダ寸法だけで一度スクロール位置を当てて
  おき、その後の遅延描画で再アンカーされないようにする

ロード時のパースは [valibot](https://valibot.dev) スキーマを使って
壊れたキャッシュエントリを安全に弾きます (`parseCachedReadingPosition`)。

---

## パスワード保護 PDF

- `getDocument({ password })` で初期パスワードを渡す
- pdf.js の `documentTask.onPassword(updatePassword, reason)` コールバック
  を実装し、`reason === 2`（誤り再試行）時はモーダルを再表示
- ユーザーがキャンセルしたら `documentTask.destroy()`
- 認証成功したパスワードは Rust 側 (`save_pdf_password` IPC) で
  ファイルパス単位に SQLite に保存。次回オープンで `get_pdf_password`
  経由で取得して自動入力

---

## アウトライン (TOC)

`pdfDocument.getOutline()` の返り値を `buildPdfToc` で再帰的に
ツリー化し、サイドの TOC パネルに描画します。各エントリのデスティネーション
は `resolvePdfLinkTarget` と同じロジックでページ番号に解決して、クリックで
ジャンプ。

---

## サムネイル生成

現状 macOS 限定実装 ([src-tauri/src/lib.rs](../src-tauri/src/lib.rs)):

- `/usr/bin/qlmanage -t` で QuickLook プレビューをサムネイル化
- `/usr/bin/sips` で正方リサイズ + フォーマット変換

生成物は OS のキャッシュディレクトリ配下 (`<app-cache>/thumbnails/...`)。

クロスプラットフォーム化するには pdf.js の canvas 描画 → `toBlob`
を経由するか、別ライブラリ (poppler-rs / mupdf-rs) を入れる必要があります。

---

## TOML/version とマイグレーションスキーム

[riida.toml](../riida.toml.example) は最近 `version` フィールドを持つように
なりました。

- 新規セーブ時は常に `CARGO_PKG_VERSION` を書き込む
- `version` 欠如 + 既存ファイルあり = 旧バージョンからの上げ。
  `tauri::Builder::setup` の中で `migrate_legacy_config_if_needed` が
  `apply_pre_version_migrations` を 1 回流して TOML を再保存
- 現在のマイグレーションは:
  > viewer_preferences の **global rows** で `binding_direction = 'left'`
  > のものを `'auto'` に昇格 (file-level rows は明示選択とみなして触らない)

将来別の config-shape 修正を入れたい場合は `apply_pre_version_migrations`
に追加するか、必要に応じて versioned ladder に分割します。

---

## 既知の課題 / TODO

- **サムネイル**: macOS 限定。Windows / Linux 対応が未着手
- **画像のみ PDF の綴じ方向**: テキストレイヤーが無い PDF は自動判定不能。
  ユーザー明示のフォールバックに頼る
- **password 保存場所**: SQLite に平文。本格運用するなら OS keychain 連携
  を検討
- **`pdf.worker.min.mjs` のサイズ**: 1.2 MB と大きい。動的 import で
  別チャンクに分離済みだが起動コスト寄与あり
