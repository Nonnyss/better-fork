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

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

async function focusTab($: EngineInterface, pid: number): Promise<boolean> {
  const ps = await $.process.run(['ps', '-o', 'tty=', '-p', String(pid)])
  const tty = ps.stdout.trim()
  if (ps.exitCode !== 0 || !tty || tty === '??') return false
  const r = await $.process.run(['osascript', '-e', FOCUS_TAB, `/dev/${tty}`])
  return r.stdout.trim() === 'ok'
}

const newTabCommand = (target: Target) =>
  target.isBg ? `claude attach ${target.short ?? target.sessionId.slice(0, 8)}` : `${target.cwd ? `cd ${quote(target.cwd)} && ` : ''}claude --resume ${target.sessionId}`

export async function openInNewTab($: EngineInterface, target: Target) {
  if (target.pid && (await focusTab($, target.pid))) return
  const cmd = newTabCommand(target)
  // Asks macOS, not TERM_PROGRAM: a background session's process has no terminal of its own to name.
  const r = await $.process.run(['osascript', '-e', NEW_TAB, cmd]).catch(() => undefined)
  if (r?.exitCode === 0 && r.stdout.trim() !== 'no-iterm') return
  await $.ui.copy({ text: cmd })
  $.ui.toast(`Copied: ${cmd}`)
}

// /resume looks only in this project's folder of transcripts, named after the project's path.
async function resumableHere($: EngineInterface, home: string, sessionId: string): Promise<boolean> {
  const root = await $.session.root()
  return $.fs.exists(`${home}/.claude/projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`)
}

/**
 * Switches this terminal to the session. Nothing is stopped until /resume is
 * known to find it here: one of another project opens in a new tab instead.
 * A session runs in one process at a time, so one live in another tab is
 * jumped to, and a background one mid-turn is left alone.
 */
export async function openHere($: EngineInterface, home: string, row: Row, target: Target) {
  if (row.isCurrent) return $.ui.toast('This is the session you are in.')
  if (target.pid) {
    if (await focusTab($, target.pid)) return $.ui.toast('It is open in another tab: switched to it.')
    return $.ui.toast('It is open in another terminal; close it there to resume it here.')
  }
  if (!(await resumableHere($, home, target.sessionId))) {
    $.ui.toast('It belongs to another project: opened in a new tab.')
    return openInNewTab($, target)
  }
  if (target.isBg && target.isLive) {
    if (row.status === 'working') {
      $.ui.toast('Still working mid-turn, so it cannot move into this terminal: opened in a new tab.')
      return openInNewTab($, target)
    }
    const stop = await $.process.run(['claude', 'stop', target.short ?? target.sessionId])
    if (stop.exitCode !== 0) return $.ui.toast(`Could not take it from the background: ${stop.stderr.trim() || stop.stdout.trim()}`)
  }
  const resumed = await $.command.run({ command: 'resume', args: target.sessionId })
  // shortcut: reads /resume's words, as command.run reports no status; read a status once it has one.
  if (/not found|no conversation/i.test(resumed.text ?? '')) $.ui.toast(`Could not resume it here. Get it back with: ${newTabCommand(target)}`)
}
