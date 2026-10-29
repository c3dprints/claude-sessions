# Changelog

Newest first. The top heading must match `version` in package.json (a test checks it).

## 1.1.0 (2026-10-28)

Claude sessions can now run inside the app, so there is no need to go back to Windows Terminal.

- Built-in terminals: **+ New session**, **Reopen** and the closed-session banner now open Claude inside the app. The full Claude Code interface runs in it, with colors, scrolling, copy (Ctrl+C on a selection) and paste (Ctrl+V, images via Alt+V).
- New layout: a sidebar lists the sessions in the app and the ones in Windows Terminal with their live status; click to switch.
- **Move here** ends an idle Windows Terminal session and continues the same conversation in the app.
- Sessions in the app run in a separate session host, so closing the window, a crash of the dashboard, or an app update does not end them. Reopening the window shows each session's recent output.
- **End session** (with a confirm) and an "ended" bar with **Reopen** and **Close**.
- Reopening in Windows Terminal is still there (the **Terminal** button on closed and past sessions).
- Security: the API now also refuses cross-site requests, so no web page can read or type into a session.
- Fix: the 3 second refresh no longer rebuilds buttons that did not change, so a click can no longer land on a button that is being replaced.

## 1.0.2 (2026-10-28)

- Fix: right after installing an update the footer still offered that same update. The saved check result is now compared with the running version.

## 1.0.1 (2026-10-28)

- Fix: after an update the restarted server could run its poll loop and update timer several times over (one extra copy per port retry while the old server let go of the port).
- Tests: a request can no longer hang the test run.

## 1.0.0 (2026-10-28)

First release.

- Dashboard of every open Claude Code session: title, folder, last prompt, and live status (Working, Needs you, or Idle).
- Go to tab: jumps to the exact Windows Terminal tab of a session.
- Recently closed: any session whose terminal goes away is listed for 7 days with a one-click Reopen (`claude --resume` in a new tab, same folder). A banner shows closes from the last 15 minutes.
- History of the last 14 days with search and Reopen.
- Rename sessions on the dashboard (stored in the app, Claude itself is untouched).
- New session in any recent folder.
- Self-update from tagged GitHub releases: checks every 6 hours, Install button, optional automatic install.
- Start with Windows switch (runs the server in the background, no window).
