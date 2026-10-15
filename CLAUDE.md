# MemoReader

> Working directory: `C:\Claude\MemoReader`

## Project Overview

Saves links and pasted text from the web/SNS (mobile share, paste on mobile or PC, Telegram bot). The PC server fetches the linked page, asks an LLM for a short summary, tags and a category, files the item into a category folder as Markdown (title, summary, original text, link, tags), and syncs the result back to every device. The original text is always kept. Details: `docs/overview.md`.

- Structure reference: `C:\Claude\SNS-Reader` (React + TS + Vite, Markdown storage, LLM enrich)
- UI reference: `C:\Claude\SongYUE2\app` (warm paper/teal palette, dark mode); LLM provider setup reference: `C:\Claude\MusicAutomation\server\services\llm.mjs`
- Three modes must keep working: phone alone, PC alone, and synced (local-first, see `memory-bank/knowledge/RULES.md` P-02)
- Ports (see `C:\Claude\PORTS.md`): backend + built app 4313, Vite dev 5182
- Auth: Tailscale only (`docs/setup-tailscale.md`); the server binds to loopback

## Project Structure

- `src/`: React + TypeScript PWA (IndexedDB local store, sync engine, pages, components)
- `backend/`: Node server (sync API, page fetch, LLM organizing, Telegram bot, auth)
- `shared/`: Logic used by both server and client (ids, URL normalization, organize prompt/result parsing)
- `public/`: Web manifest (with share target), service worker, icons
- `data/`: Private user data, never commit. `data/vault_output/` holds the notes (an Obsidian vault, see `docs/obsidian.md`, folder set by `VAULT_DIR`); `data/runtime/` holds settings and keys
- `docs/`: Project documentation
- `scripts/`: Maintenance scripts (icon generation)
- `test/`: Backend tests
- `memory-bank/`: Project context and accumulated engineering knowledge

## Tech Stack

- Client: React + TypeScript + Vite PWA, shared by mobile and PC (responsive), plain CSS tokens from SongYUE2
- Backend: Node (no web framework), `cross-spawn` for CLI LLM providers
- Storage: Markdown with JSON-valued frontmatter under `data/vault_output/<category>/<title> (<id>).md`; Obsidian-safe tags and file names
- UI (PC): sidebar category tree, card/list/mesh views, pop-up detail, per-card favorite/edit/delete icons; (phone): category picker on top, same list/detail pages as before
- LLM: chosen in the Settings screen (claude-cli, codex-cli, opencode-cli, ollama, anthropic, openai, gemini)
- Sync: last-writer-wins by `updatedAt`, tombstones for deletes, cursor-based pull

## Commands

```bash
start.bat          # build, then run the app on http://127.0.0.1:4313 (frees the port first)
start.bat dev      # API with auto-restart (4313) + Vite dev server (5182)
stop.bat           # stop both ports and MemoReader node windows
npm test           # backend tests (node --test "test/*.test.mjs")
npm run build      # typecheck + production build
npm run icons      # regenerate PWA icons
scripts\autostart-install.bat   # start MemoReader at logon (scheduled task); autostart-remove.bat undoes it
```

The PC is only on in the evening: on start the server drains the backlog (pending items, items that failed only for lack of an LLM, queued Telegram messages). Phones that enabled notifications get a Web Push (15 s after start, and again once the queue empties); the service worker (`src/sw.ts`, built by `vite.sw.config.ts`) then syncs while the app is closed. `npm test` includes `test/sw.test.mjs`, which runs the built worker against a real backend.

Phone access: `tailscale serve --bg 4313` (see `docs/setup-tailscale.md`).

## Memory Bank

At the start of a session, read `memory-bank/active-context.md` and then `memory-bank/STATE.md`.
