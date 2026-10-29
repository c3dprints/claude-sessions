# Changelog

Newest first. The top heading must match `version` in package.json (a test checks it).

## 1.4.0 (2026-10-29)

15 popular terminal themes in Settings, each with its full 16-color palette, taken from the theme's own repo: Dracula, Nord, Tokyo Night, Catppuccin Mocha, Gruvbox Dark, One Half Dark, Solarized Dark, Rose Pine, Kanagawa, Everforest, GitHub Dark, and the light GitHub Light, Catppuccin Latte, Solarized Light and Rose Pine Dawn. All are open source (MIT; Tokyo Night Apache-2.0). Where a theme's published "bright black" matched its background (Solarized Dark, One Half Dark, Everforest) it uses the usual readable grey instead. The app's own 7 looks are listed above them.

## 1.3.1 (2026-10-29)

- The app now has its own taskbar button with the Claude Sessions icon, instead of being grouped under the Edge or Chrome icon. Pinning that button to the taskbar opens the app the normal way.

## 1.3.0 (2026-10-29)

Settings, an update button, themes and terminal colors.

- **Settings** (gear at the bottom left of the sidebar): Updates (your version, Check now, Install, install automatically), Start with Windows, the app theme and the terminal look. The footer that used to hold these is gone.
- **Update icon** next to All sessions: one click checks for a new version and says what it found. It spins while checking and shows a dot when an update is ready (click it to install) or the last check failed.
- **App theme**: System (follows Windows), Dark or Light.
- **Terminal look**: seven presets (Claude Sessions, Midnight, Graphite, Forest, Plum, Ember, Paper), or pick your own background, text and cursor colors, plus the text size. Changes apply to every terminal in the app right away, with a live sample, and **Reset to default** undoes them.

## 1.2.1 (2026-10-28)

Easier to gather sessions into a project.

- **Add sessions…** on a project's page: a searchable list of every session (open now, recently closed, and every older one Claude still has), tick as many as you like and add them in one go. Sessions in another project move over.
- **Drag and drop**: drag any session card, History row or sidebar session onto a project in the sidebar.
- Sessions put in a project stay on its page however old they are, not just for the 14 days History shows.
- The project chip on a session now reads **+ Add to project**.

## 1.2.0 (2026-10-28)

Projects, plan usage, context, skills and the wiki, all in the app.

- **Projects**: group sessions like the Claude desktop app does. A project has a name, a color and folders; sessions in those folders join it by themselves, and any session can be put in a project (or kept out of one) from the chip on its card. Each project has its own page with its open, closed and past sessions and a **New session** button per folder. The sidebar lists projects with how many sessions are open, working or waiting.
- **Plan usage in the header**: how much of the current 5-hour session and of the week you have used, with the time left until each resets. Claude Code only shares these numbers with its status line, so **Turn on** (under Context and usage) adds a small status line that saves them for the app. It also shows the model, context and usage at the bottom of every Claude terminal. It never replaces a status line you already have, and **Turn off** removes it.
- **Context and usage** view, like `/context`: a square grid of each open session's context window, split into what the session started with, memory files and the conversation, plus free space and where your settings compact it. Every session card and terminal bar shows its context percentage too.
- **Skills**: every skill and command Claude can use (personal, claude.ai, plugins, projects), searchable and filterable, with the full instructions of each one and how many tokens it costs.
- **Wiki**: the pages of the wiki on `\\Mobius\Chris` and everything in Claude's memory, searchable, with tables and links between pages. **Folders** changes where the wiki lives.

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
