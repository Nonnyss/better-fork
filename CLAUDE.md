# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What lives here

- `better-fork/`: a Claude Code mod (plugin with a hooks module) that draws every Claude Code session as a fork tree in a sidebar pane, with status, click-to-switch, a `⋯` row menu, an all/this-project filter, and auto-folding.
- `.claude-plugin/marketplace.json`: makes this repo the `local-mods` marketplace. The user-scope install `better-fork@local-mods` is read straight from `better-fork/` (no copy).
- `.brilliant/`, `Assets/`, `Styles/`, `main.bl`: Brilliant design files, unrelated to the mod. Leave them alone.

## Commands

Run from the repo root:

```bash
claude plugin test better-fork        # all *.test.ts(x); no per-file filter, exits 1 on failure
(cd better-fork && tsc -p .)          # type-check; tsconfig extends .claude-plugin/types/tsconfig.json
claude plugin validate better-fork    # what the engine would refuse; README/LICENSE/icon warnings are directory-only, ignore them
```

- `better-fork/.claude-plugin/types/` is written by the engine when it loads the mod (API types, ~22k lines; grep it, don't read it). It is gitignored.
- After editing, the change reaches a session only when `/reload-plugins` runs **in that session**. Every session is its own process with its own copy of the mod. A stale copy warns on its status line ("better-fork updated · run /reload-plugins").
- A headless load check: `claude -p --model haiku --debug-file <log> "reply ok"`, then grep the log for `better-fork`.

## Architecture

Data flows in one direction: files on disk → `Session[]` → `Row[]` (in a `$.state` atom) → pane render → clicks posted back.

- **Sources** (`hooks/sources.ts`, `readSessions`): `~/.claude/jobs/<short>/state.json` (fleet jobs, the same data as Claude Code's background-sessions view: `name`, `state`, `forkParentSessionId`, `cwd`, `daemonShort`) merged with `~/.claude/sessions/<pid>.json` (live processes: `kind` `interactive`|`bg`, `status`, `pid`, `jobId`). Live sessions are re-read every second and the ~200 job files every fifth tick, only for files whose mtime changed, and only while a surface is attached (background sessions have none). A job waits (`blocked`) when either `state` or `tempo` says so, as the fleet view counts it; `needs` is its question.
- **Tree** (`hooks/tree.ts`, `treeRows`): pure. The parent comes from `forkParentSessionId`, else from the name lineage `#182⑂2⑂1-slug` (written by `~/.claude/hooks/session-namer.js`). Missing parents become placeholder rows. Sessions sharing a name are merged. Folds a quiet subtree after a day, splits the rest into `today` (touched since local midnight) and `earlier` rules (a lone section draws no rule), and puts trees quiet for 3 days under an "older" row. Stars (a starred row leaves its place, forks and all, for the top under `★ starred`; drawn once) and hidden sessions (out of the tree and the counts; shown flat under `◌ hidden`, ids prefixed `◌`) are row ids kept in `$.store`. `unfold: true` gives the tree `/` search filters. Two sessions given one number keep separate row ids.
- **Geometry** (`hooks/look.ts`): status glyphs/colours (mirrors `Styles/fork-tree.ds`), the working spinner frames, label clipping (Thai combining marks take zero cells), and `layout()`, which places the fold caret, the label, and a fixed `⋯ age` column at `dotX(width)`.
- **Pane** (`register.tsx`, `ui.render`): one cell of padding each side; header (filter Buttons, the `/` search `Input`, counts) plus a `Client` whose module is `hooks/tree-view.tsx`. On surfaces without `Client` (vscode, mobile) it draws one line only.
- **Client module** (`hooks/tree-view.tsx`): runs on the drawing thread with no `$`. It handles the pointer itself (fold, open, the retro `⋯` menu, the rename field, the delete dialog, the clickable key bar) and posts `{ act, id, text? }`; `register.tsx` answers in its `ui.message` hook. Search is the header's `Input`, whose text reaches the Client as the `query` prop. One `every(120 ms)` timer redraws only while a working row or a switch is on screen. Hit-testing re-derives x positions from `layout()`, so geometry changes touch both files.
- **No hotkeys, on purpose.** Measured in a real terminal: a Client gets keys only after a click inside it (every spot in the tree acts on a click), Escape never reaches it, and the pane's `isFocused` stays false while it holds the keys, so it never learns it lost them. Only the rename field reads keys (opened by a click, closed by its clickable `⏎ save`/`esc cancel`). A menu closes on pointer `leave`. The key letters stay as labels.
- **Switching** (`hooks/switch.ts`, `openHere` / `openInNewTab`): the order is load-bearing:
  1. A live interactive session is focused in its iTerm tab (tty from `ps`, AppleScript).
  2. A background session mid-turn opens in a new tab: it can't move into this terminal without interrupting it.
  3. `/resume` only finds transcripts under `~/.claude/projects/<project path with every non-alphanumeric as '-'>/`. A session whose transcript sits under its own folder is reached by `/cd <its cwd>` first, checked with `$.session.root()`, so its `.mcp.json`, settings and CLAUDE.md apply. One found under neither its folder nor this one opens in a new tab and is never stopped.
  4. An idle background session is `claude stop`ped only after that, then `$.command.run({ command: 'resume' })`. A failed stop `/cd`s back.
  5. A new tab runs `cd <cwd> && claude attach|--resume …`, every value quoted. iTerm is detected with osascript, not `TERM_PROGRAM` (background sessions have none). Without iTerm the command is copied instead.
     Each step is posted to the `opening` atom, which the row shows as a sweep and a `╰ step…` line.
- **Rename / Delete** (`hooks/manage.ts`): rename keeps the lineage and appends `custom-title`/`agent-name` rows to the transcript (this session: `/rename`); `$.store` `names` maps the old name to the new until the fleet's files catch up. Delete refuses this session, a live tab and a working one, then `claude stop`, `claude rm <short>`, and moves the transcript to `~/.Trash`.
- **Toasts** (`register.tsx`, `toastChanges`): a row turning `blocked` (with its `needs`) or a working row turning done/idle, never on the first scan nor for this session; several in one scan fold into one toast.

## Engine rules that bite

- `claude plugin validate` refuses `$` passed to anything but a top-level function or an import, and refuses a shadowed `next`.
- No redraw per pointer move: hover made the whole tree stutter. A move calls `setState` only when the hovered row (or the `⋯` menu item) changes; `leave` clears the hover.
- iTerm keeps right-click for its own menu, which is why the `⋯` column exists.
- The dock is 24 columns minimum and 45% of the terminal maximum. A width the person dragged beats `$.ui.open({ columns })`.
- Tests (`claude-code/testing`) stand in for the engine with `on(...)` hooks. `pane.test.tsx`'s `start()` fakes the disk and the processes; rows are clicked by `{ x, y }` in the `tree` Client, so adding fixture sessions shifts row positions.
