# riida

`riida` is a desktop reading app and library manager for your local PDF and EPUB collection.

It was built for readers who own hundreds or thousands of ebooks and want a single bookshelf with a built-in reader, fast search, notes, and metadata management.

The name comes from "Reader."

![](img/screenshot-main.png)

## What you can do

- Index PDFs and EPUBs from one or more folders you choose, and keep them in sync as files change
- Browse your library by directory, tag, or full-text search across titles and authors
- Read PDFs and EPUBs in the built-in viewer, with viewer settings remembered per file
- Take notes on any book, autosaved to your machine
- Edit metadata (title, authors, publisher, release date, language, cover, etc.)
- Tag books and bulk-edit tags or metadata for many books at once
- Track external books you don't own a file for — for example, register Kindle purchases as library entries with metadata

## Install

Download an installer for your platform from:

- [riida releases](https://github.com/zonuexe/riida/releases)

### macOS

riida is not signed with a paid Apple Developer ID, so Gatekeeper may refuse to open it on first launch. To allow it:

1. Move `riida.app` to `/Applications`
2. Run:

   ```bash
   xattr -cr /Applications/riida.app
   ```

3. Open the app

This is intended for personal use on your own machine.

## Quick start

1. Launch the app and open **Settings**
2. Add one or more folders containing your PDFs/EPUBs to **Library roots**
3. Save — riida scans the folders and shows your library on the main screen
4. Click any book to start reading

The library refreshes automatically when you add or remove files in those folders.

## Power-user tools

### Update book metadata via Claude Code (MCP server)

riida ships with an [MCP](https://modelcontextprotocol.io/) server that lets [Claude Code](https://claude.com/product/claude-code) (or Claude Desktop) read your library and fill in missing metadata for you.

With the MCP server configured, you can ask Claude things like:

```
Find books missing title or author, read the first few pages of each PDF,
guess the title and author from the content, and write the metadata back.
```

You can also combine it with [techbook-mcp](https://github.com/zonuexe/techbook-mcp) to look up Japanese technical books by title and bulk-fill metadata across your library.

For setup and the full tool list, see [`mcp-server/README.md`](mcp-server/README.md).

### Amazon.co.jp metadata bookmarklet

On a Kindle Store / ebook product page on **Amazon.co.jp**, this bookmarklet scrapes the visible product details and copies them as JSON to your clipboard. The JSON shape matches what riida's book metadata editor accepts in its **JSON import** field (title, authors, description, publisher, release date, language, ASIN, cover URL).

**Install:** create a new bookmark and paste the entire string below into the bookmark's URL / location field (it must start with `javascript:`). Then open an Amazon.co.jp product page and activate the bookmark.

**Notes:** Amazon may change their HTML at any time, which can break extraction. Bookmarklets run in the page context — only install code you trust. Clipboard copy requires a secure context (`https://`) and may prompt for permission in some browsers.

```text
javascript:(async()=>{const norm=s=>(s||'').replace(/[\u200e\u200f\xa0]/g,' ').replace(/\s+/g,' ').trim();const uniq=arr=>[...new Set(arr.filter(Boolean))];const pick=selectors=>{for(const selector of selectors){const el=document.querySelector(selector);if(!el)continue;const text=norm(el.textContent);if(text)return text;}return'';};const fallbackTitle=()=>{let t=document.querySelector('meta[name="title"]')?.content||document.title||'';t=norm(t).replace(/^Amazon\.co\.jp:\s*/,'').replace(/\s+eBook\s*:\s.*$/,'').replace(/\s*:\s*Kindleストア\s*$/,'');if(t.includes(' | '))t=t.split(' | ')[0];return norm(t);};const cleanLabel=s=>norm(s).replace(/\s*[:：]\s*$/,'').trim();const parseDate=s=>{s=norm(s);let m=s.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/)||s.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);if(!m)return'';const[,y,mo,d]=m;return`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;};const parseLanguage=s=>{s=norm(s);const map={'日本語':'ja','英語':'en','フランス語':'fr','ドイツ語':'de','スペイン語':'es','イタリア語':'it','ポルトガル語':'pt','ロシア語':'ru','韓国語':'ko','中国語':'zh','中国語(簡体字)':'zh-Hans','中国語（簡体字）':'zh-Hans','中国語(繁体字)':'zh-Hant','中国語（繁体字）':'zh-Hant'};if(map[s])return map[s];const m=s.match(/^([a-z]{2})(?:[-_][A-Za-z]{2,4})?$/i);return m?m[1].toLowerCase():'';};const addDetail=(details,label,value)=>{label=cleanLabel(label);value=norm(value);if(label&&value&&!(label in details))details[label]=value;};const extractDetails=()=>{const details={};document.querySelectorAll('#detailBulletsWrapper_feature_div li,#detailBullets_feature_div li').forEach(li=>{const labelEl=li.querySelector('.a-text-bold');if(!labelEl)return;const label=cleanLabel(labelEl.textContent);let value='';const listItem=li.querySelector('.a-list-item')||li;for(const child of Array.from(listItem.children)){if(child===labelEl)continue;const text=norm(child.textContent);if(text){value=text;break;}}if(!value){value=norm(li.textContent.replace(labelEl.textContent,'')).replace(/^[:：]\s*/,'');}addDetail(details,label,value);});document.querySelectorAll('#productDetails_detailBullets_sections1 tr,#productDetails_techSpec_section_1 tr').forEach(tr=>{addDetail(details,tr.querySelector('th')?.textContent,tr.querySelector('td')?.textContent);});document.querySelectorAll('.rpi-attribute-content').forEach(card=>{addDetail(details,card.querySelector('.rpi-attribute-label,[class*="attribute-label"]')?.textContent,card.querySelector('.rpi-attribute-value,[class*="attribute-value"]')?.textContent);});return details;};const extractAuthors=()=>uniq(Array.from(document.querySelectorAll('#bylineInfo .author,#bylineInfo_feature_div .author')).map(el=>{const a=el.querySelector('a');const raw=a?a.textContent:(el.childNodes[0]?.textContent||el.textContent||'');return norm(raw).replace(/\s*\([^)]*\)\s*,?$/,'').trim();}));const extractDescription=()=>{const root=document.querySelector('#bookDescription_feature_div .a-expander-content')||document.querySelector('#bookDescription_feature_div')||document.querySelector('#productDescription');if(!root)return'';const clone=root.cloneNode(true);clone.querySelectorAll('script,style,noscript').forEach(n=>n.remove());return norm(clone.textContent.replace(/続きを読む|もっと少なく読む/g,''));};const extractCover=()=>{const img=document.getElementById('landingImage')||document.getElementById('imgBlkFront')||document.getElementById('ebooksImgBlkFront');if(!img)return'';let url=img.getAttribute('data-old-hires');if(!url){const dyn=img.getAttribute('data-a-dynamic-image');if(dyn){try{const urls=Object.keys(JSON.parse(dyn));url=urls[urls.length-1];}catch(e){}}}return url||img.src||'';};const details=extractDetails();const data={};const title=pick(['#productTitle','#ebooksProductTitle','h1#title span','#title span'])||fallbackTitle();const authors=extractAuthors();const description=extractDescription();const publisher=details['出版社']||'';const releaseDate=parseDate(details['発売日']||'')||parseDate(pick(['#productSubtitle']));const language=parseLanguage(details['言語']||'');const asin=norm(document.querySelector('#ASIN')?.value||details['ASIN']||details['ISBN-10']||'');const coverUrl=extractCover();if(title)data.title=title;if(authors.length)data.authors=authors;if(description)data.description=description;if(publisher)data.publisher=publisher;if(releaseDate)data.releaseDate=releaseDate;if(language)data.language=language;if(asin)data.asin=asin;if(coverUrl)data.coverUrl=coverUrl;const json=JSON.stringify(data,null,2);const copy=async text=>{if(navigator.clipboard&&window.isSecureContext){try{await navigator.clipboard.writeText(text);return true;}catch(_){}}const ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.top='0';ta.style.left='0';ta.style.opacity='0';document.body.appendChild(ta);ta.focus();ta.select();ta.setSelectionRange(0,ta.value.length);let ok=false;try{ok=document.execCommand('copy');}catch(_){}ta.remove();return ok;};const copied=await copy(json);if(copied){alert('JSONをクリップボードにコピーしました。\n\n'+json);}else{prompt('コピーに失敗したため、ここから手動でコピーしてください。',json);}})().catch(err=>{console.error(err);alert('抽出に失敗しました: '+(err&&err.message?err.message:err));});
```

## Configuration file (optional)

Most settings can be changed from the **Settings** screen. If you prefer editing a config file directly, riida reads:

- `~/.config/riida/riida.toml` when `~/.config` exists
- otherwise the OS-native config directory

Example:

```toml
library_roots = ["~/Documents/Ebooks/"]
excluded_patterns = ["**/backup/**", "*.bak.pdf"]
pdf_renderer = "pdfjs"
```

riida stores library data in the OS data directory and thumbnails in the OS cache directory. Older versions kept these in the project root; existing files are migrated forward automatically on startup when possible.

## License

This project is licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/). See [`LICENSE`](LICENSE).

Bundled third-party dependencies are listed in [`THIRD-PARTY-LICENSES-rust.md`](THIRD-PARTY-LICENSES-rust.md) and [`THIRD-PARTY-LICENSES-js.md`](THIRD-PARTY-LICENSES-js.md). Vendored assets keep their own license texts in the repository (e.g. [Font Awesome](src/vendor/fontawesome/LICENSE.txt)).

> This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at <https://mozilla.org/MPL/2.0/>.

Copyright belongs to the contributors to this repository unless otherwise noted.

## For developers

- [CONTRIBUTING.md](CONTRIBUTING.md) — minimum contributor workflow
- [DESIGN.md](DESIGN.md) — UI design system
- [docs/design-doc.md](docs/design-doc.md) — architecture and system design
- [AGENTS.md](AGENTS.md) — implementation notes and development setup
