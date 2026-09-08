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

## スキャン PDF の傾き補正 (deskew)

### 背景

BOOKSCAN などの裁断スキャン PDF は、1 ページごとに 0.5〜1° 程度紙面が傾いて
取り込まれていることが多く、しかも表 / 裏で傾きの符号が反転する（フィーダの
癖で偶数ページと奇数ページが逆方向に倒れる）。ページ単位で角度を測って
逆回転させないと直らない。

ビューア設定 `deskewMode` (`"off"` | `"auto"`、既定 `"off"`) を `"auto"` に
すると、pdfjs 経路でページごとに傾きを検出して水平に補正表示する。
全体 / ファイル両スコープで保存でき、設定パネルでは PDF 専用の
チェックボックス「スキャンの傾きを補正する」として出す。

### 検出 (projection profile 法)

[src/pdf-deskew.ts](../src/pdf-deskew.ts) の `detectSkewAngle` は純粋関数で、
グレースケール画像を受け取り次の手順で角度を求める:

1. 外周 6% をクロップ（スキャナの影や紙端の線を投票させない）
2. Otsu 法で二値化してインク画素の座標を集める。インクが少なすぎる
   （白紙）/ 多すぎる（写真・網掛け）ページはここで `null`
3. 候補角度 ±3° を 0.25° 刻みで走査し、各角度でインク画素を
   「行に直交する軸」へ投影したヒストグラムの二乗和をスコアにする。
   行が水平になる角度でだけ行ごとに画素が同じビンへ集中するので、そこが
   ピークになる。縦書き（tategaki）用に「列に直交する軸」でも同じ走査を
   行い、ピークが中央値からより突出した向きを採用する
4. 粗い勝者の周囲を 0.05° 刻みで詰める
5. ピーク / 中央値 が 1.12 未満（信号が弱い: 図版、雑誌の複雑なレイアウトなど）、
   勝者が走査範囲の端（真の角度が範囲外）、|角度| < 0.1°（実質水平）なら `null`

符号は画面座標系で「右下がりが正」。補正は `rotate(-angle)`。
実データでの較正結果（`エンタープライズ アプリケーションアーキテクチャパターン`
の 24〜29 ページ）: 偶数ページ +0.75°、奇数ページ −0.6° で安定、1 ページ
あたり 2〜4 ms。文庫の縦書き小説では columns 側が勝ち、マンガは `null`
（補正なし）になる。

### 適用: canvas transform に畳み込む

補正は CSS で回すのではなく、pdf.js `page.render` の `transform` 引数に
「中心まわりの逆回転 (+ トリミング無しならカバースケール)」を `outputScale`
と合成して渡す ([src/pdf-page-transform.ts](../src/pdf-page-transform.ts)
の `pageContentTransform`)。回転した内容が枠をはみ出さないよう
`scale = cos θ + max(w/h, h/w)·sin θ` だけ拡大し（1° で約 2.5%）、canvas の
矩形がそのままクリップになる。これによりページ枠・影・白地は真っ直ぐな
まま、印字だけが水平になる。

pdf.js が viewport 座標でそのまま並べる `.textLayer` と `.annotationLayer`
には、`.pdfjs-page[data-content-transform]` と `--pdf-overlay-transform`
（CSS px での同じアフィン行列）を通じて同じ変換を CSS で掛け、選択範囲や
リンクのヒット領域を描画と一致させる (`applyPdfPageOverlayTransform`)。
スタンドアロン窓の `.pdfjs-link-layer` はパーセント配置なので、リンク矩形を
JS 側で同じ行列に通してから配置する (`mapRectThroughMatrix`)。

### 実行順序とキャッシュ

`renderPdfRenderPlan` は本番描画の **前** に
[src/pdf-page-sample.ts](../src/pdf-page-sample.ts) の
`PdfPageAnalyzer.analyze` を呼ぶ。これは長辺 640px のサンプル描画（pdf.js は
画像デコード結果をページ単位でキャッシュしているので安価）→ `getImageData`
→ 傾き検出とインク矩形計測（後述のトリミング用）、という流れで、結果は
`(filePath, pageNumber)` 単位でメモ化する。ズームやリサイズによる再描画は
キャッシュヒットで済み、別ファイルを開くと破棄される。測定に失敗した
ページは「水平・計測なし」として記憶し、描画自体は止めない。

スタンドアロン窓 ([src/main-viewer.ts](../src/main-viewer.ts)) も同じ
analyzer と変換関数を使う。`deskewMode` の変更はレイアウト変更扱いで
窓をリロードする。

テストは [src/pdf-deskew.test.ts](../src/pdf-deskew.test.ts)（合成した
「行組み」「縦組み」画像で ±0.12° 以内に収まること、白紙 / ノイズ /
範囲外傾きで `null` になること）、
[src/pdf-page-transform.test.ts](../src/pdf-page-transform.test.ts)
（変換行列が canvas の 4 隅を覆うこと、クロップとの合成）、
[src/pdf-page-sample.test.ts](../src/pdf-page-sample.test.ts)（fake の
page / canvas で analyzer のキャッシュが効くこと）。合成ページの生成は
[src/pdf-page-fixtures.ts](../src/pdf-page-fixtures.ts) に共通化してある。

---

## スキャン PDF の余白トリミング (trim)

### 背景

裁断スキャンは紙面全体を取り込むので、画面上では印字領域の周りに何の
情報もない余白が付く。見開き表示ではこの余白ぶんだけ本文が小さくなり、
「幅に合わせる」では縦がウィンドウに収まらず、「高さに合わせる」では
本文が小さくなる。ビューア設定 `trimMode` (`"off"` | `"auto"`、既定
`"off"`、設定パネルの「余白をトリミングする」) を `"auto"` にすると、
印字領域だけを切り出して表示する。

注意: トリミングで小さくなるのは **紙面** であって、印字領域の縦横比は
変わらない。この本 (A5 相当、柱とノンブルを含む印字領域の縦横比 ≈ 0.94)
の見開きは幅に合わせると依然として画面高さを超える。トリミングの効果が
出るのは「高さに合わせる」で、余白ぶんだけ本文が大きくなる
（この本では約 11%）。

### 計測: インク矩形 (`measureInkBox`)

[src/pdf-trim.ts](../src/pdf-trim.ts)。傾き検出と同じ 640px サンプルから:

1. 外周 2% は無視（スキャナの影を印字扱いしない）
2. Otsu 二値化した行 / 列ごとのインク画素数を数え、閾値
   `max(3, 長さ×0.4%)` 以上の行（列）が **2 本連続** する範囲を印字とみなす。
   ホコリや 1px のスキャン線は矩形を広げず、3 桁のノンブル程度は印字として
   数える
3. 結果はページに対する比率 `{left, top, right, bottom}`

傾き補正が有効なら、そのページの角度で矩形の 4 隅を回転させた外接矩形を
使う (`rotateInkBox`)。補正後の描画位置と一致させるため。

### 集約: 文書ごとに奇数 / 偶数の 2 箱 (`aggregateTrimBoxes`)

ページごとに切ると本文の大きさや枠がページによって跳ぶので、文書ごとに
1 組の箱を決める。見開きは左右で柱・ノンブル・のど余白が鏡像なので、
左右の辺は **ページ番号の偶奇ごと** に、上下の辺は **全サンプル共通** に
集約し、見開きの高さを揃える。

各辺は「サンプルの 1/8 を外れ値として捨てた上で最も外側の値」を採る
（16 サンプルなら 2 つ、偶奇別 8 サンプルなら 1 つ）。全面図版が 1 ページ
混ざっても紙端まで箱が広がらず、普通のページの印字は欠けない。最後に
1.5% のパディングを足して [0,1] にクランプし、幅か高さが 30% 未満なら
ノイズとみなして全面 (トリミング無し) に戻す。

サンプルページは `trimSamplePageNumbers`: 文書を 8 等分した位置とその
次ページ (偶奇を必ず両方含める) の最大 16 ページ。32 ページ以下なら全部。

実データ (ファウラー本 24〜29, 200〜201, 400〜401 ページ) での箱: 偶数
`L0.02–0.06 / R0.89`、奇数 `L0.10 / R0.95–0.98`、上下 `0.065 / 0.94`。
外側の辺 (偶数の左、奇数の右) には柱 (縦書きの見出し) とノンブルが
紙端近くまで印字されているので、そこは削れない。

### 適用とキャッシュ

`renderCurrentPage` は綴じ方向の判定後、レイアウト前に
`resolvePdfTrimBoxes` で箱を決める（進捗は "Measuring margins (n/16)..."）。
以降のページサイズ計算 (`basePageSize`) はすべてトリミング後のサイズを使い、
描画時は `cropRectForPage` で得た矩形を `pageContentTransform` の `crop`
に渡す。crop 付きのときは deskew のカバースケールを掛けない（余白が
角を隠すので不要）。

計測結果は `localStorage` の `riida:pdf-trim:<filePath>` に
`{version, pageCount, deskew, odd, even}` として保存し (valibot スキーマで
検証)、ページ数か deskew 設定が変わると捨てる。初回オープンだけ 16 ページ
ぶんのサンプル描画コスト (数百 ms〜1 秒程度) がかかる。

テストは [src/pdf-trim.test.ts](../src/pdf-trim.test.ts) と
[src/pdf-page-sample.test.ts](../src/pdf-page-sample.test.ts)。

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

`itemIndex` は `.textLayer` 内の text span を DOM 順に数えた添字としてそのまま
使うので、インデックスに入れるアイテムは pdf.js の `TextLayer` が span を
追加するものと 1 対 1 で一致していなければなりません。`TextLayer` は
`str === ""` のアイテム（行末の `hasEOL` マーカーなど）の span を DOM に
追加せず、marked-content マーカー (`str === undefined`) は `span.markedContent`
ラッパーにしかならないため、`collectPdfTextLayerItems` で両方を落としてから
`buildPdfSearchPageIndex` に渡します。DOM 側も `span:not(.markedContent)` で
拾います。ここがずれると空アイテム 1 個ごとにハイライトが 1 span ぶん
後ろへ流れていきます。

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
