# Metadata bridge — future extension candidate (parked)

> **Status: parked idea, not the current direction.** The near-term approach is
> the [`riida-metadata-enrichment` skill](../../skills/riida-metadata-enrichment/SKILL.md):
> the user's own AI agent invokes it and orchestrates the already-connected
> `riida` + `techbook-mcp` servers — no sidecar, no bundled LLM. This document is
> kept as a candidate for later, when a GUI flow for **non-MCP users** is wanted.

A thin prototype for exposing the "auto-fill book metadata" workflow to riida
**GUI users**, using [aichat](https://github.com/sigoden/aichat) as the fuzzy
bridge between two **deterministic** MCP servers.

```
 EXTRACT (deterministic)        BRIDGE (fuzzy / LLM)            RESOLVE (deterministic)
 ┌───────────────────┐         ┌──────────────────────┐        ┌──────────────────────┐
 │ riida-mcp         │         │ aichat agent          │        │ techbook-mcp         │
 │  read_pdf_colophon│ ──奥付──▶│  "riida-metadata"     │──ISBN─▶│  resolve_book(s)     │
 │  read_pdf_pages   │         │  (propose-only;       │◀─書誌──│  get_book_by_isbn    │
 │  get_book_metadata│◀─現状───│   read tools only)    │        │  search_books        │
 └───────────────────┘         └──────────┬───────────┘        └──────────────────────┘
                                           │ JSON proposals (auto_apply / review / skip)
                                           ▼
                                ┌──────────────────────┐
                                │ riida app (Rust/TS)   │  ← review UI, then applies
                                │  update_books_metadata│    APPROVED items only
                                └──────────────────────┘
```

The LLM only does the **non-deterministic judgement** (which clue to use, cleaning
split author names, edition/title-variant matching, confidence calls). Both ends
stay deterministic, and **the write is deterministic and human-gated** — the agent
is physically read-only (see below).

## Why propose-only
The agent's `use_tools` allow-list **omits `update_books_metadata`**, so the model
cannot mutate the library. It emits JSON proposals; riida applies the approved ones
itself. This keeps the safety net we validated in practice:
- `high` + `isbnTitleAgree=true` → auto-fill **empty** fields only.
- low / ambiguous / `isbnTitleAgree=false` / not_found → human review.
- `validation.isbnTitleAgree=false` already caught a real case where an ebook
  printed another title's ISBN (レガシーソフトウェア改善ガイド → ガベージコレクション).

## Files
- [`mcp.json`](./mcp.json) — registers `riida` + `techbook` MCP servers for the
  llm-functions bridge.
- [`riida-metadata.agent.yaml`](./riida-metadata.agent.yaml) — the aichat agent
  (model, propose-only `use_tools`, instructions).
- [`instructions.md`](./instructions.md) — the agent's system prompt: procedure,
  decision rules, field hygiene, and the JSON proposal schema.

## Setup (one-time, for trying it manually)
1. Install aichat and the llm-functions MCP bridge; copy `mcp.json` into
   `llm-functions/` and build the bridge.
2. Install the agent: copy `riida-metadata.agent.yaml` →
   `<aichat-config-dir>/agents/riida-metadata/index.yaml`, and paste
   `instructions.md` into its `instructions` (or `index.md`).
3. Pick a model. For zero-cost / offline, set `model: ollama:<local-model>`.
4. Confirm tool names: `aichat --list-tools` — adjust `use_tools` to match the
   bridge's actual (possibly namespaced) names; keep `update_books_metadata` OUT.

## Invocation (how riida drives it, as a sidecar)
One-shot, bounded to an explicit file list, capturing JSON on stdout:

```sh
aichat --agent riida-metadata --no-stream \
  '次のファイルのメタデータ提案をJSONで返して: ["/abs/a.pdf","/abs/b.epub"]'
```

riida then:
1. parses `proposals`,
2. **auto-applies** `action:"auto_apply"` via its own `update_books_metadata`
   (empty fields only),
3. shows `action:"review"` items in a calm review sheet (confidence chip,
   proposed-vs-current diff, candidates, colophon snippet) for accept/skip,
4. lists `action:"skip"` with reasons.

Alternative: run `aichat --serve` and POST to `/v1/chat/completions`; same agent,
same JSON contract.

## To verify against current aichat (build-time TODO)
- Exact tool-name surface from the llm-functions MCP bridge (namespacing).
- Whether per-server `allowed_tools` exists, or `use_tools` alone is the allow-list.
- Agent file layout for the installed aichat version (`index.yaml` vs `config.yaml`,
  inline `instructions` vs `index.md`).

## Caveats for public release
- **LLM dependency**: needs a model (BYO key or local Ollama). Offer an offline
  fallback that fills only the deterministic colophon fields when no model/network.
- **Scope**: Japanese tech books (colophon parsing + JP publishers via techbook).
- **ToS / rate limits**: techbook-mcp fetches publisher sites — cache, rate-limit,
  attribute; lean on openBD (free, bulk-friendly) as the core, publisher pages as
  enrichment.
- **Cost**: don't spend tokens on the deterministic 90%. Resolve as much as
  possible in riida/techbook directly; invoke the LLM only for the fuzzy remainder.

## Next slice (not in this prototype)
- riida Rust command + background job that runs the sidecar and parses proposals.
- The review-sheet UI (per DESIGN.md: translucent sheet, confidence chips,
  diff, batch-apply high-confidence).
