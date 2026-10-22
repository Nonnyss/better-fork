# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What lives here

- `fork-tree/`: a Claude Code mod (plugin with a hooks module) that draws every Claude Code session as a fork tree in a sidebar pane, with status, click-to-switch, a `⋯` row menu, an all/this-project filter, and auto-folding.
- `.claude-plugin/marketplace.json`: makes this repo the `local-mods` marketplace. The user-scope install `fork-tree@local-mods` is read straight from `fork-tree/` (no copy).
- `.brilliant/`, `Assets/`, `Styles/`, `main.bl`: Brilliant design files, unrelated to the mod. Leave them alone.

## Commands

Run from the repo root:

```bash
claude plugin test fork-tree        # all *.test.ts(x); no per-file filter, exits 1 on failure
(cd fork-tree && tsc -p .)          # type-check; tsconfig extends .claude-plugin/types/tsconfig.json
claude plugin validate fork-tree    # what the engine would refuse; README/LICENSE/icon warnings are directory-only, ignore them
```

- `fork-tree/.claude-plugin/types/` is written by the engine when it loads the mod (API types, ~22k lines; grep it, don't read it). It is gitignored.
- After editing, the change reaches a session only when `/reload-plugins` runs **in that session**. Every session is its own process with its own copy of the mod. A stale copy warns on its status line ("fork-tree updated · run /reload-plugins").
- A headless load check: `claude -p --model haiku --debug-file <log> "reply ok"`, then grep the log for `fork-tree`.

## Architecture

Data flows in one direction: files on disk → `Session[]` → `Row[]` (in a `$.state` atom) → pane render → clicks posted back.

- **Sources** (`hooks/register.tsx`, `scan`): `~/.claude/jobs/<short>/state.json` (fleet jobs, the same data as Claude Code's background-sessions view: `name`, `state`, `forkParentSessionId`, `cwd`, `daemonShort`) merged with `~/.claude/sessions/<pid>.json` (live processes: `kind` `interactive`|`bg`, `status`, `pid`, `jobId`). Re-read every 5 s, only for files whose mtime changed, and only while a surface is attached (background sessions have none).
- **Tree** (`hooks/tree.ts`, `treeRows`): pure. The parent comes from `forkParentSessionId`, else from the name lineage `#182⑂2⑂1-slug` (written by `~/.claude/hooks/session-namer.js`). Missing parents become placeholder rows. Sessions sharing a name are merged. Folds a quiet subtree after a day, and puts trees quiet for 3 days under an "older" row.
- **Geometry** (`hooks/look.ts`): status glyphs/colours, label clipping (Thai combining marks take zero cells), and `layout()`, which places the fold caret, the label, and a fixed `⋯ age` column at `dotX(width)`.
- **Pane** (`register.tsx`, `ui.render`): header (filter Buttons, counts) plus a `Client` whose module is `hooks/tree-view.tsx`. On surfaces without `Client` (vscode, mobile) it draws one line only.
- **Client module** (`hooks/tree-view.tsx`): runs on the drawing thread with no `$`. It handles pointer and keys itself (fold, open, the retro `⋯` menu) and posts `{ act, id }`; `register.tsx` answers in its `ui.message` hook. Hit-testing re-derives x positions from `layout()`, so geometry changes touch both files.
- **Switching** (`register.tsx`, `openHere` / `openInNewTab`): the order is load-bearing:
  1. A live interactive session is focused in its iTerm tab (tty from `ps`, AppleScript).
  2. `/resume` only finds transcripts under `~/.claude/projects/<project path with every non-alphanumeric as '-'>/`. Any other session opens in a new tab and is never stopped.
  3. A background session mid-turn opens in a new tab: it can't move into this terminal without interrupting it.
  4. An idle background session is `claude stop`ped first, then `$.command.run({ command: 'resume' })`.
  5. iTerm is detected with osascript, not `TERM_PROGRAM` (background sessions have none). Without iTerm the command is copied instead.

## Engine rules that bite

- `claude plugin validate` refuses `$` passed to anything but a top-level function or an import, and refuses a shadowed `next`.
- No redraw per pointer move: hover made the whole tree stutter. A move calls `setState` only when the hovered row (or the `⋯` menu item) changes; `leave` clears the hover.
- iTerm keeps right-click for its own menu, which is why the `⋯` column exists.
- The dock is 24 columns minimum and 45% of the terminal maximum. A width the person dragged beats `$.ui.open({ columns })`.
- Tests (`claude-code/testing`) stand in for the engine with `on(...)` hooks. `pane.test.tsx`'s `start()` fakes the disk and the processes; rows are clicked by `{ x, y }` in the `tree` Client, so adding fixture sessions shifts row positions.
