<div align="center">

# better-fork

**See every Claude Code session as a fork tree, right beside your chat.**

[Features](#features) · [Getting started](#getting-started) · [Usage](#usage) · [How it works](#how-it-works) · [Development](#development)

</div>

```
all · better-fork
? 1 need you  ● 3 working
▾● #182 auth-refactor              ⋯  5m
├─○ ⑂1 login-form                  ⋯  1h
├▾● ⑂2 fix-login                   ⋯  1m
│ └─? ⑂1 tests                     ⋯  3m
└▸✓ ⑂3 docs +2                     ⋯  1d
 ✗ #190 deploy-fix                 ⋯  4h
⏎ here · t new tab · m menu · ←→ fold
```

better-fork is a Claude Code mod that opens a sidebar pane listing all your sessions: interactive tabs, background jobs and closed transcripts. Each fork sits under the session it came from. You can see which sessions need you, which are working and which are done, and switch to any of them with one click.

## Features

- **Fork tree**: each fork is drawn under its parent, even when the parent's files are gone.
- **Live status**: `?` needs you, `●` working, `✗` failed, `○` idle, `✓` done. The header counts how many need you and how many are working.
- **Click to switch**: opens the session in this terminal, jumps to the iTerm tab where it is already open, or opens it in a new tab.
- **Auto-folding**: a quiet subtree folds after a day. Trees quiet for three days go under an "older" row.
- **Filter**: show every session, or only the ones in this project (worktrees included).
- **Row menu**: the `⋯` column opens a menu to open here, open in a new tab, or copy the session id.

## Getting started

### Requirements

- [Claude Code](https://claude.com/claude-code) with mod (hooks module) support
- macOS with [iTerm2](https://iterm2.com) to focus and open tabs

> [!NOTE]
> Without iTerm2 the pane still works. "Open in new tab" copies the command for you to paste instead.

### Install

This repo is also a plugin marketplace called `local-mods`. Add it, then install the mod:

```bash
git clone https://github.com/Nonnyss/better-fork.git
claude plugin marketplace add ./better-fork
claude plugin install better-fork@local-mods
```

The pane opens on its own in every new terminal session. To open it by hand, run `/better-fork`.

> [!TIP]
> The plugin is read straight from the cloned folder. After you pull or edit, run `/reload-plugins` in each open session; a session running an old copy says so on its status line.

## Usage

| Action | Mouse | Keyboard |
|---|---|---|
| Move the selection | | `↑` `↓` |
| Open in this terminal | Click the row | `⏎` |
| Open in a new tab | | `t` |
| Copy the session id | | `c` |
| Open the row menu | Click `⋯` | `m` |
| Fold or unfold | Click the caret | `←` `→` |
| Filter | Click `all` or the project name | |

Switching here never interrupts work:

1. A session already open in another iTerm tab is focused, not reopened.
2. A session from another project opens in a new tab, since `/resume` only finds this project's transcripts.
3. A background session that is mid-turn opens in a new tab.
4. An idle background session is stopped, then resumed in this terminal.

## How it works

Every 5 seconds the mod reads two folders, and only while the pane is visible:

- `~/.claude/jobs/*/state.json`: background jobs, the same data as Claude Code's background-sessions view.
- `~/.claude/sessions/*.json`: live processes, including interactive tabs.

The parent of each session comes from `forkParentSessionId`. When that is missing, the mod reads it from the name instead: names like `#182⑂2⑂1-slug` give the lineage. If several sessions share a name, as happens after a resume, they become one row.

```
better-fork/
├── .claude-plugin/plugin.json
├── hooks/
│   ├── register.tsx   # hooks, pane state and render
│   ├── sources.ts     # reads sessions from disk
│   ├── tree.ts        # sessions → rows (pure)
│   ├── look.ts        # glyphs, colours, row layout
│   ├── switch.ts      # open here / in a new tab
│   └── tree-view.tsx  # client: pointer, keys, menu
└── types/index.d.ts
```

## Development

Run from the repo root:

```bash
claude plugin test better-fork       # run all tests
(cd better-fork && tsc -p .)         # type-check
claude plugin validate better-fork   # what the engine would refuse
```

> [!IMPORTANT]
> `better-fork/.claude-plugin/types/` is written by the engine when it loads the mod, and it is gitignored. Load the mod once before you type-check.
