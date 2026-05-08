---
title: ライブラリの設定
description: ライブラリルートフォルダの追加・変更方法を説明します。
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
      {"@context":"https://schema.org","@type":"HowTo","name":"ライブラリの設定","description":"ライブラリルートフォルダの追加・変更方法を説明します。","inLanguage":"ja","step":[{"@type":"HowToStep","position":1,"name":"設定を開く","text":"サイドバー上部のメニューから設定を開きます。"},{"@type":"HowToStep","position":2,"name":"ライブラリタブを選択","text":"ライブラリタブを選択します。"},{"@type":"HowToStep","position":3,"name":"フォルダを追加","text":"「＋ フォルダを追加」ボタンをクリックしてフォルダを選択します。"}],"url":"https://zonuexe.github.io/riida/library-setup/"}
---

riidaはライブラリルートとして登録したフォルダを再帰的にスキャンし、PDFとEPUBを自動でインデックス化します。

## ライブラリルートを追加する

1. サイドバー上部のメニューから **設定** を開きます
2. **ライブラリ** タブを選択します
3. 「＋ フォルダを追加」ボタンをクリックしてフォルダを選択します
4. 追加したフォルダは即座にスキャンが開始されます

複数のルートフォルダを登録できます。

## 除外パターンの設定

特定のフォルダやファイルをスキャン対象から除外したい場合は、glob形式のパターンを設定します。

**例：**

```
**/backup/**
*.bak.pdf
**/tmp/**
```

設定画面の「除外パターン」欄に1行ずつ入力します。

## ファイルの自動追跡

ライブラリルートに追加・変更・削除があると、riidaは自動で検知してライブラリを更新します。手動での再スキャンは通常必要ありません。

## 設定ファイルの場所

ライブラリ設定は `~/.config/riida/riida.toml` に保存されます。

```toml
library_roots = ["~/Documents/Ebooks/"]
excluded_patterns = ["**/backup/**"]
```
