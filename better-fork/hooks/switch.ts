import type { EngineInterface } from 'claude-code'

import type { Row, Target } from '../types'

const FOCUS_TAB = `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is (item 1 of argv) then
            select w
            tell t to select
            tell s to select
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "none"
end run`

const NEW_TAB = `on run argv
  if application "iTerm2" is not running then return "no-iterm"
  tell application "iTerm2"
    activate
    if (count of windows) is 0 then
      set w to (create window with default profile)
    else
      set w to current window
      tell w to create tab with default profile
    end if
    tell current session of w to write text (item 1 of argv)
  end tell
end run`

// Only what the shell would read as more than one word gets quotes, so a plain id stays readable in a copied command.
const quote = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** Where Claude Code keeps a project's transcripts: the path with every non-alphanumeric as '-'. */
export const transcriptOf = (home: string, cwd: string, sessionId: string) => `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`

async function focusTab($: EngineInterface, pid: number): Promise<boolean> {
  const ps = await $.process.run(['ps', '-o', 'tty=', '-p', String(pid)])
  const tty = ps.stdout.trim()
  if (ps.exitCode !== 0 || !tty || tty === '??') return false
  const r = await $.process.run(['osascript', '-e', FOCUS_TAB, `/dev/${tty}`])
  return r.stdout.trim() === 'ok'
}

// Every value comes from a JSON file on disk and is typed into a shell, so each is quoted. The cd first keeps
// the session in its own project: its .mcp.json, settings and CLAUDE.md.
export const newTabCommand = (target: Target) =>
  (target.cwd ? `cd ${quote(target.cwd)} && ` : '') + (target.isBg ? `claude attach ${quote(target.short ?? target.sessionId.slice(0, 8))}` : `claude --resume ${quote(target.sessionId)}`)

export async function openInNewTab($: EngineInterface, target: Target) {
  if (target.pid && (await focusTab($, target.pid))) return
  const cmd = newTabCommand(target)
  // Asks macOS, not TERM_PROGRAM: a background session's process has no terminal of its own to name.
  const r = await $.process.run(['osascript', '-e', NEW_TAB, cmd]).catch(() => undefined)
  if (r?.exitCode === 0 && r.stdout.trim() !== 'no-iterm') return
  await $.ui.copy({ text: cmd })
  $.ui.toast(`Copied: ${cmd}`)
}

const tilde = (home: string, path: string) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path)

/**
 * Switches this terminal to the session, in its own folder. /resume finds a
 * transcript only under the project the session is in, so one kept under the
 * session's own folder is reached by /cd there first; nothing is stopped until
 * that move is known to have worked. One found nowhere opens in a new tab.
 * A session runs in one process at a time, so one live in another tab is
 * jumped to, and a background one mid-turn is left alone. `step` names each
 * stage as it starts, for the pane to show.
 */
export async function openHere($: EngineInterface, home: string, row: Row, target: Target, step: (text: string) => void = () => {}) {
  if (row.isCurrent) return $.ui.toast('This is the session you are in.')
  if (target.pid) {
    if (await focusTab($, target.pid)) return $.ui.toast('It is open in another tab: switched to it.')
    return $.ui.toast('It is open in another terminal; close it there to resume it here.')
  }
  if (target.isBg && target.isLive && row.status === 'working') {
    $.ui.toast('Still working mid-turn, so it cannot move into this terminal: opened in a new tab.')
    return openInNewTab($, target)
  }
  const root = await $.session.root()
  const cwd = target.cwd && target.cwd !== root && (await $.fs.exists(transcriptOf(home, target.cwd, target.sessionId))) ? target.cwd : undefined
  if (!cwd && !(await $.fs.exists(transcriptOf(home, root, target.sessionId)))) {
    $.ui.toast('Its transcript is not under its folder or this one: opened in a new tab.')
    return openInNewTab($, target)
  }
  if (cwd) {
    step(`cd ${tilde(home, cwd)}`)
    await $.command.run({ command: 'cd', args: cwd })
    if ((await $.session.root()) !== cwd) {
      $.ui.toast(`Could not move this session to ${tilde(home, cwd)}: opened in a new tab.`)
      return openInNewTab($, target)
    }
  }
  if (target.isBg && target.isLive) {
    step('stop background job')
    const stop = await $.process.run(['claude', 'stop', target.short ?? target.sessionId])
    if (stop.exitCode !== 0) {
      // Back where it was, so a failed switch leaves this session as it found it.
      if (cwd) await $.command.run({ command: 'cd', args: root })
      return $.ui.toast(`Could not take it from the background: ${stop.stderr.trim() || stop.stdout.trim()}`)
    }
  }
  step('load transcript')
  const resumed = await $.command.run({ command: 'resume', args: target.sessionId })
  // shortcut: reads /resume's words, as command.run reports no status; read a status once it has one.
  if (/not found|no conversation/i.test(resumed.text ?? '')) $.ui.toast(`Could not resume it here. Get it back with: ${newTabCommand(target)}`)
}
