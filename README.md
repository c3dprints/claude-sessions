# Claude Sessions

A small local dashboard that shows every Claude Code terminal session on this PC, so none gets closed by accident, and any that do can be reopened in one click.

## What it does

- **Open now**: one card per running `claude` process with its title, folder, last prompt and live status (**Working**, **Needs you** when a permission prompt is open, or **Idle**).
- **Go to tab**: brings the right Windows Terminal tab to the front.
- **Recently closed**: when a session's terminal goes away it shows up here (kept 7 days) with **Reopen**, which runs `claude --resume <id>` in a new tab in the same folder.
- **History**: the last 14 days of sessions, searchable, each one reopenable.
- **Rename**, **New session** in a recent folder, **Start with Windows**, **self-update**.

## How it works

Claude Code keeps a file per running process in `~/.claude/sessions/<pid>.json` (session id, folder, busy or idle) and a transcript per session in `~/.claude/projects/<folder>/<id>.jsonl`. The server reads both every 3 seconds and checks each pid against the running `claude.exe` processes. It never writes to `~/.claude`.

Tab jumping uses Windows UI Automation (`scripts/focus-tab.ps1`): it walks from the claude process up to its terminal window and selects the tab whose name contains the session title.

- Node 18+, no dependencies.
- Port **8930**, bound to 127.0.0.1 only. Tests use **8931**.
- App state (nicknames, closed list, settings): `%LOCALAPPDATA%\ClaudeSessions\data\state.json`, plus `server.log`.

## Install

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

This clones the repo to `%LOCALAPPDATA%\ClaudeSessions\app`, checks out the newest release tag, and puts a **Claude Sessions** shortcut on the Desktop. Run it again any time to repair the install.

## Updates

The installed copy is a git clone sitting on a release tag. Every 6 hours (and on **Check now**) it fetches tags from GitHub; if a newer `vX.Y.Z` exists the footer shows **Install and restart**, or it installs by itself when **Install updates automatically** is on. A copy on a branch (the dev checkout) never moves itself.

## Releasing

1. Make the change, run `npm test`.
2. Bump `version` in `package.json` and add a matching `## x.y.z` entry at the top of `CHANGELOG.md`.
3. Commit, then `npm run release`. It checks everything, pushes `main`, and pushes the `vX.Y.Z` tag. Installed copies pick it up on their next check.

## Files

| File | Job |
|---|---|
| `server.js` | HTTP server, poll loop, API, update timer |
| `lib/sessions.js` | Reads the session registry and transcripts |
| `lib/store.js` | App state and closed-session tracking |
| `lib/terminal.js` + `scripts/focus-tab.ps1` | Go to tab, reopen, new session |
| `lib/updater.js` | Tag check and install |
| `lib/startup.js` | Start with Windows shortcut |
| `launch.js` + `scripts/launch.vbs` | One-click launcher (no console window) |
| `public/index.html` | The dashboard |
