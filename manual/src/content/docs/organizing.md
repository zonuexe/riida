---
title: 書籍の整理
description: タグ、メタデータ、シェルフを使った書籍の分類・管理方法を説明します。
draft: false
head:
  - tag: meta
    attrs:
      property: og:locale
      content: ja_JP
  - tag: script
    attrs:
      type: application/ld+json
    content: |-
      {"@context":"https://schema.org","@type":"Article","name":"書籍の整理","description":"タグ、メタデータ、シェルフを使った書籍の分類・管理方法を説明します。","inLanguage":"ja","about":{"@type":"SoftwareApplication","name":"riida"},"url":"https://zonuexe.github.io/riida/organizing/"}
---

## タグ

タグを使うと書籍を自由に分類できます。

### タグを付ける

1. 書籍の行を右クリックするか、書籍を開いた状態でタグアイコンをクリックします
2. 入力欄にタグ名を入力して Enter キーを押します
3. 既存のタグはオートコンプリートで表示されます

### タグで絞り込む

サイドバーのタグ一覧からタグをクリックすると、そのタグが付いた書籍だけを表示できます。

### 複数書籍への一括タグ付け

メインリストで複数の書籍を選択し（⌘クリックまたはShiftクリック）、右クリックメニューから「タグを編集」を選択します。

## メタデータの編集

書籍を右クリックして「メタデータを編集」を選択すると、以下の情報を編集できます。

| フィールド | 説明 |
|-----------|------|
| タイトル | 書籍名 |
| 著者 | 1行に1名 |
| 出版社 | 出版社名 |
| 発売日 | YYYY-MM-DD 形式 |
| 言語 | 言語コード（例: `ja`, `en`） |
| 説明 | あらすじなど |
| カバーURL | カバー画像のURL |
| URL | 書籍の公式ページ等 |
| <abbr title="Amazon Standard Identification Number">ASIN</abbr> | AmazonのASIN |

### JSONパッチインポート

複数フィールドをまとめて更新したい場合、JSONパッチ形式で一括入力できます。

```json
{
  "title": "新しいタイトル",
  "authors": ["著者名"],
  "language": "ja"
}
```

省略したフィールドは変更されません。`null` を指定するとそのフィールドをクリアします。

## シェルフ（棚）

シェルフは独自の条件で書籍を分類する仮想コレクションです。
サイドバーから「シェルフを追加」でシェルフを作成し、条件（タグ、言語、出版社など）を設定します。

## 検索

サイドバー上部の検索欄からタイトル・著者名でライブラリ内を検索できます。
