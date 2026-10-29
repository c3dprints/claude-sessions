# Claude Sessions

A local app for every Claude Code session on this PC: run sessions in built-in terminals, see the ones in Windows Terminal, and reopen anything that got closed by accident in one click.

## What it does

- **Built-in terminals**: start, reopen or move a session into the app and work with Claude right there. Sessions in the app keep running when the window is closed or the app updates itself.
- **Sidebar**: every session with its live status (**Working**, **Needs you** when a permission prompt is open, or **Idle**). Click one in the app to switch to it; click one in Windows Terminal to jump to its tab.
- **Move here**: ends an idle Windows Terminal session and continues the same conversation inside the app.
- **Recently closed**: when a session goes away it shows up here (kept 7 days) with **Reopen** (in the app) or **Terminal** (in Windows Terminal), both running `claude --resume <id>` in the same folder.
- **History**: the last 14 days of sessions, searchable, each one reopenable.
- **Projects**: name, color and folders. Sessions in a project's folders join it by themselves; any session can be put in or kept out of a project by hand. Each project has its own page.
- **Plan usage** in the header (current 5-hour session and week, with reset times) and a **Context and usage** view that splits each session's context window like `/context`.
- **Skills**: every skill and command from `~/.claude/skills`, claude.ai, plugins and project folders, with its instructions and token cost.
- **Wiki**: the markdown pages in the wiki folders (`\\Mobius\Chris` by default) and Claude's auto memory, searchable.
- **Rename**, **New session** in a recent or project folder, **Start with Windows**, **self-update**.

## How it works

Claude Code keeps a file per running process in `~/.claude/sessions/<pid>.json` (session id, folder, busy, idle or waiting) and a transcript per session in `~/.claude/projects/<folder>/<id>.jsonl`. The server reads both every 3 seconds and checks each pid against the running `claude.exe` processes.

Context use comes from the transcripts too: each reply records the tokens it was sent, so the last one is how full the window is and the first one is what the session started with.

Plan usage (5-hour and weekly limits) reaches only Claude Code's status line. **Turn on** in Context and usage copies `scripts/statusline.js` to the data folder and sets `statusLine` in `~/.claude/settings.json` to run it; the script saves `data/status/usage.json` and one `data/status/<session>.json` per session and prints a short line in the terminal. That one setting is the only thing the app ever writes in `~/.claude`, and only when asked; an existing status line is never replaced.

Built-in terminals have three parts:

| Part | Job |
|---|---|
| `native/conpty-bridge.cs` | Tiny C# program that runs `claude.exe` inside a Windows pseudo console (ConPTY) and relays bytes over its stdin and stdout. Compiled on first use with the `csc.exe` that ships with Windows, into `%LOCALAPPDATA%\ClaudeSessions\bin`, named by a hash of its source. |
| `ptyhost.js` | The session host: a separate background process that owns every in-app session and keeps 2 MB of scrollback per session. The dashboard talks to it over a named pipe with a secret token (`data\host.token`). Because it is separate, restarting or updating the dashboard never ends a session. It is only replaced after an update once no session is running on it. |
| `public/vendor/xterm.js` | The terminal on the page (xterm.js 5.5.0, MIT, see `LICENSE-xterm.txt`). One event stream carries every session's output; keystrokes go back as small POSTs. |

Ctrl+C copies when text is selected and interrupts Claude otherwise. Ctrl+V pastes text; with an image on the clipboard it sends Alt+V so Claude Code reads the image itself.

Tab jumping for Windows Terminal sessions uses Windows UI Automation (`scripts/focus-tab.ps1`).

- Node 18+, no npm dependencies.
- Port **8930**, bound to 127.0.0.1 only. Tests use **8931**. The API refuses other hosts, other origins and cross-site requests, so no web page can type into a session.
- App state (nicknames, closed list, projects, settings), status line data and logs: `%LOCALAPPDATA%\ClaudeSessions\data` (`state.json`, `server.log`, `host.log`).

## Install

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

This clones the repo to `%LOCALAPPDATA%\ClaudeSessions\app`, checks out the newest release tag, and puts a **Claude Sessions** shortcut on the Desktop. Run it again any time to repair the install.

## Updates

The installed copy is a git clone sitting on a release tag. Every 6 hours (and on **Check now**) it fetches tags from GitHub; if a newer `vX.Y.Z` exists the footer shows **Install and restart**, or it installs by itself when **Install updates automatically** is on. Only the dashboard restarts; sessions in the app keep running. A copy on a branch (the dev checkout) never moves itself.

## Releasing

1. Make the change, run `npm test`.
2. Bump `version` in `package.json` and add a matching `## x.y.z` entry at the top of `CHANGELOG.md`.
3. Commit, then `npm run release`. It checks everything, pushes `main`, and pushes the `vX.Y.Z` tag. Installed copies pick it up on their next check.

## Files

| File | Job |
|---|---|
| `server.js` | HTTP server, poll loop, API, terminal event stream, update timer |
| `ptyhost.js` | Session host (see above) |
| `native/conpty-bridge.cs` | ConPTY bridge (see above) |
| `lib/sessions.js` | Reads the session registry and transcripts |
| `lib/store.js` | App state, closed-session tracking, projects |
| `lib/library.js` | Wiki pages, memory files and skills (read only) |
| `lib/usage.js` + `scripts/statusline.js` | Plan usage, the status line switch, context windows |
| `lib/hostclient.js` | Starts, connects to and upgrades the session host |
| `lib/bridge.js` | Compiles the bridge |
| `lib/terminal.js` + `scripts/focus-tab.ps1` | Windows Terminal: go to tab, reopen, new session |
| `lib/updater.js` | Tag check and install |
| `lib/startup.js` | Start with Windows shortcut |
| `launch.js` + `scripts/launch.vbs` | One-click launcher (no console window) |
| `public/index.html` | The app |
