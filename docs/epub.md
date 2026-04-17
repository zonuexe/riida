# EPUB ビューア改善メモ

このドキュメントは「電書連 EPUB 3 制作ガイド ver.1.1.4」(dpfj-guide.txt) を読んで抽出した、
riida の EPUB ビューア実装に関係する設計指針と改善候補をまとめたものです。

## 改善候補（優先度順）

### 高優先度

#### 内部 `#anchor` リンクをページ番号ジャンプへ置換

**根拠（ガイド §ページ内リンク）**

> ページメディアでは「そのアンカーを含むページを単に表示する」ほうが都合が良い場合も考えられる。

現象：epub.js のデフォルト実装は `#anchor` リンクをスクロール型で処理するため、
paginated モードではレイアウトが壊れる（右ペインに1ページ丸ごとが展開される）。

対処方針：
- `rendition.hooks.content.register` 内でアンカーリンクを検出
- `book.locations.cfiFromHref(href)` などで対応する CFI を取得
- `rendition.display(cfi)` によるページ番号ジャンプへ置換
- epub.js 自身の `replaceLinks` が内部リンクを処理する前にフックする

#### 固定レイアウト (pre-paginated) 検出と切り替え

**根拠（ガイド §固定レイアウト）**

> 固定レイアウトへの対応は画像のみで構成される作品に限ること。カバーページは
> `rendition:page-spread-center`、以降は必ずペアで作成する。

現状：リフロー型のみ対応。固定レイアウト EPUB を開くと表示が崩壊する可能性あり。

対処方針：
- OPF から `<meta property="rendition:layout">pre-paginated</meta>` を検出
- リフロー時：現状通り `flow: "paginated"`, `spread: "none"`
- 固定レイアウト時：`flow: "pre-paginated"`, `spread: "auto"` に切り替え
- カバーが `rendition:page-spread-center` の場合も正しく表示

### 中優先度

#### カバー画像抽出とサムネイル対応

**根拠（ガイド §カバー画像）**

> カバー画像のファイル名は特に指示がない場合 `cover.jpg` で統一。
> カバー画像が存在しないケースもある。

現状：EPUB のサムネイル生成は未実装。

実装指針（優先順）：
1. OPF で `<item properties="cover-image">` を持つアイテムのパスを使用
2. なければ `cover.jpg` / `cover.png` / `cover.webp` をフォールバック
3. それも無ければ代替画像（現状のグレーボックス）

#### `-epub-writing-mode` 優先の注入 CSS

**根拠（ガイド §`-epub-` 接頭辞付き CSS プロパティの優先的解釈）**

> `-epub-` 接頭辞付きを最優先で解釈する。`-webkit-` が先に書かれていても
> `-epub-` を優先することが望ましい。

WKWebView は `-webkit-writing-mode` をネイティブ解釈するため、両方が指定された
書籍では順序次第で縦組みが壊れる場合がある。

対処方針：
```typescript
rendition.hooks.content.register((contents: Contents) => {
  const style = contents.document.createElement("style");
  style.textContent = `
    /* Prefer -epub-writing-mode over -webkit- as per DPFJ guide */
    [style*="-epub-writing-mode"] { writing-mode: inherit; }
  `;
  contents.document.head.appendChild(style);
});
```

#### body マージンをゼロに

**根拠（ガイド §ページメディアの余白）**

> RS が body 要素内部に独自の余白を追加することはない。
> 書籍データで指定された margin / padding を RS が勝手に変更しない。

epub.js はデフォルトで body に padding を注入することがある。
書籍側で `margin: 0; padding: 0` を指定していても RSが追加する余白で崩れる。

対処方針：
```typescript
book.rendition.themes.default({
  body: { padding: "0 !important", margin: "0 !important" }
});
```
ただし、余白なしで見切れる書籍もあるため、ユーザー設定化を検討。

#### page-progression-direction と左右キーの整合確認

**根拠（ガイド §ページ進行方向の遵守）**

> `-epub-writing-mode` にかかわらず、ページ進行方向は OPF `spine` の
> `page-progression-direction` 属性に従う。

縦組み日本語書籍（`page-progression-direction="rtl"`）で Previous/Next キーが
逆方向になっていないか確認が必要。

確認事項：
- `book.package.metadata.direction` または `book.spine.direction` を読む
- rtl 書籍で右キー → `rendition.prev()` になっているか

### 低優先度

#### `<dc:creator>` 複数著者 + `opf:role` のメタデータ取込

**根拠（ガイド §メタデータ等の扱い）**

> 複数の `<dc:creator>` がある場合、すべての著作者名が表示されること。
> role 属性（aut / edt / ill / trl など）で役割を区別する。

将来 EPUB からメタデータを自動取込するときの設計指針。
role に応じて「著者」「翻訳」「イラスト」などラベルを出し分ける。

#### 画像タップで原寸ズーム

**根拠（ガイド §縮小画像のユーザー操作による拡大）**

> 縮小して表示されている画像はピンチイン等で原寸サイズまで拡大可能であること。

EPUB / PDF 両ビューアで画像タップ → オーバーレイ拡大表示の UI を検討。

#### WebP を画像パイプラインに追加

**根拠（ガイド §画像の種類）**

> JPEG / PNG / GIF / WebP が利用可能。WebP は EPUB 3.3 より追加。

EPUB 内画像を処理・キャッシュするコードがあれば `.webp` を許可リストに追加。

---

## 外部リンク・mailto 問題（未解決）

`https://` や `mailto:` リンクが WKWebView のクロスフレーム制約で反応しない問題は
このガイドでは言及されていない（EPUB 制作者向けガイドのため）。

引き続き AGENTS.md に記録されている通り、Tauri の Rust 側 `on_navigation` ハンドラ
経由でのインターセプトが本命。

---

## 参照

- 電書連 EPUB 3 制作ガイド ver.1.1.4 (2025/10/24)
  - https://www.dpfj.or.jp/
- W3C EPUB 3.3: https://www.w3.org/TR/epub-33/
- epub.js: https://github.com/futurepress/epub.js
