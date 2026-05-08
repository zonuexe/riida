---
title: riidaとは
description: riidaの概要、主な機能、設計思想について説明します。
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
      {"@context":"https://schema.org","@type":"TechArticle","name":"riidaとは","description":"riidaの概要、主な機能、設計思想について説明します。","inLanguage":"ja","about":{"@type":"SoftwareApplication","name":"riida","applicationCategory":"UtilitiesApplication"},"url":"https://zonuexe.github.io/riida/introduction/"}
---

riida（リーダ）は、ローカルのPDF・EPUBコレクションのためのデスクトップ読書アプリ兼ライブラリマネージャーです。

数百〜数千冊の電子書籍を所有しているユーザーが、一つの本棚で書籍の管理・検索・閲覧・メモ取りをすべてこなせることを目指して設計されています。

## 主な機能

### ライブラリ管理

- 指定したフォルダからPDFとEPUBを自動でインデックス化
- ファイルの追加・変更・削除をリアルタイムで追跡
- 複数のライブラリルートフォルダを登録可能
- 除外パターン（glob形式）でスキャン対象を絞り込める

### 読書

- 内蔵PDFビューアでテキスト選択、リンク、全文検索に対応
- 読書位置をファイルごとに自動保存・復元
- 綴じ方向の自動検出（日本語縦書きPDFにも対応）
- EPUBビューア（開発中）

### 書籍の整理

- タグを使った分類
- タイトル・著者・出版社・言語・カバー画像などのメタデータ編集
- 複数書籍への一括タグ付け・メタデータ編集
- シェルフ（棚）を使ったカスタムコレクション管理

### ノートと外部書籍

- 書籍ごとのフローティングノート（Milkdownエディタ、自動保存）
- Kindle購入作品など、ファイルを持たない外部書籍の仮想登録

## 設計思想

riidaは「読書ファースト」を基本コンセプトとしています。

- 機能はリーダーとしての体験を妨げない範囲で提供する
- 落ち着いた温かみのある外観（ウォームライブラリテーマ）
- 派手なダッシュボードではなく、書斎に置かれた道具としての佇まい

## 対応プラットフォーム

現在はmacOSを主なターゲットとして開発されています。Windows・Linuxのビルドも提供していますが、macOSほどの品質保証はありません。

## 名前の由来

riidaは「Reader（リーダー）」に由来します。
