# Changelog

Newest first. The top heading must match `version` in package.json (a test checks it).

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
