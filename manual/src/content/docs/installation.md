---
title: インストール
description: riidaのダウンロードとインストール方法を説明します。
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
      {"@context":"https://schema.org","@type":"HowTo","name":"インストール","description":"riidaのダウンロードとインストール方法を説明します。","inLanguage":"ja","step":[{"@type":"HowToStep","position":1,"name":"ダウンロード","text":"GitHubのリリースページから最新版の.dmgファイルをダウンロードします。"},{"@type":"HowToStep","position":2,"name":"インストール","text":"ダウンロードした.dmgを開き、riida.appを/Applicationsフォルダにドラッグします。"},{"@type":"HowToStep","position":3,"name":"初回起動","text":"ターミナルでxattr -cr /Applications/riida.appを実行してから起動します。"}],"url":"https://zonuexe.github.io/riida/installation/"}
---

## 動作環境

- **macOS** — macOS 13 (Ventura) 以降を推奨。Apple SiliconおよびIntel Mac対応
- **Windows / Linux** — ビルドを提供していますが、macOSほどの動作確認はされていません

## インストール手順（macOS）

### 1. ダウンロード

[GitHub のリリースページ](https://github.com/zonuexe/riida/releases) から最新版の `.dmg` ファイルをダウンロードします。

- Apple Silicon Mac: `riida_x.y.z_aarch64.dmg`
- Intel Mac: `riida_x.y.z_x64.dmg`

### 2. インストール

1. ダウンロードした `.dmg` を開きます
2. `riida.app` を `/Applications` フォルダにドラッグします

### 3. 初回起動

riidaは有料のApple Developer IDで署名されていないため、初回起動前にターミナルで以下のコマンドを実行して署名検証を解除してください。

```bash
xattr -cr /Applications/riida.app
```

その後は通常通りダブルクリックで起動できます。

## インストール後の設定

初回起動後、最初にライブラリのルートフォルダを設定します。
詳しくは[ライブラリの設定](../library-setup/)を参照してください。

## アンインストール

`/Applications` フォルダから `riida.app` をゴミ箱に移動します。

設定ファイルやデータを合わせて削除したい場合は、以下のフォルダも削除します：

| 種別 | パス |
|------|------|
| 設定 | `~/.config/riida/` |
| データ（DB・サムネイル） | `~/Library/Application Support/riida/` |
| キャッシュ | `~/Library/Caches/riida/` |
