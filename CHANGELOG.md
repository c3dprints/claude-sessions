# Changelog

Newest first. The top heading must match `version` in package.json (a test checks it).

## 1.5.7 (2026-10-30)

The phone layout fits the screen.

- The phone keyboard now shrinks the app instead of covering it. Android Chrome used to lay the keyboard over the page and let it pan around behind, which showed empty space around the app; now the terminal and the key row sit right above the keyboard.
- The page no longer zooms, bounces or pulls to refresh like a web page, and its height follows the browser's address bar as it shows and hides.
- On phones the header is one row (menu, name, plan meter), so the terminal gets more of the screen. The open, working and idle counts are left out there; the session list shows each state.

## 1.5.6 (2026-10-30)

Scroll the chat on a phone.

- Swiping up or down in a terminal now scrolls Claude's chat on touch screens. Claude Code asks for mouse reports and scrolls its own chat on mouse wheel events; a mouse wheel sends those, a finger swipe sent nothing, so on a phone earlier parts of the chat could not be reached. A vertical swipe now sends the same wheel steps a mouse does (or scrolls the terminal's own history when the program is not listening to the mouse). Tapping to type works as before.

## 1.5.5 (2026-10-29)

The taskbar shows the app's icon again.

- Since 1.5.2 the page asks for the app's own taskbar button every time it loads, but that never took effect: the helper was started without a console window, and Windows PowerShell quits at once and does nothing when started that way. The window stayed grouped under Edge (or Chrome) with the browser's icon. The server now starts the helper normally, hidden, and it works.
- The launcher no longer starts the helper itself; it quit right after opening the window, which would have stopped the helper too. The page's own request covers it.

## 1.5.4 (2026-10-29)

A paired phone stays paired.

- Opening the app on the phone from a link in another app (a message, a note, a chat) showed the pairing page again, although the phone was still paired. The phone's cookie is now SameSite=Lax instead of Strict, so the browser sends it on those visits too. Changes still need a same-origin request with the app's header, so this opens nothing to other sites.
- If the pairing page shows up anyway, it checks in the background and goes straight into the app when the phone is paired after all. Phones paired on an older version switch to the new cookie on their next visit, no pairing needed.
- Each visit renews the cookie for another year.
- Opening the PC by its tailnet name (like http://pc:8930) now goes to the tailnet address. Browsers keep a separate cookie for each address, so the name used to ask for pairing again.

## 1.5.3 (2026-10-29)

Install the app on your phone.

- The app can now be added to a phone's home screen with its own icon and opens full screen, without the browser bar (app manifest, phone icons, a small service worker that caches nothing).
- **Set up HTTPS** in Settings, Phone access: phones only offer **Install app** over HTTPS, so this turns on Tailscale Serve, which gives the PC an https://<name>.<tailnet>.ts.net address with a real certificate, visible only on your tailnet. If HTTPS certificates are off for your tailnet, Settings says where to switch them on. Phones on that address still have to pair, exactly like on the plain address; requests through it never get the trust a request from the PC itself gets.
- Over the plain http address, **Add to Home screen** still makes a shortcut (it opens in the browser).

## 1.5.2 (2026-10-29)

- Fix: the taskbar button could fall back to a plain browser icon (and group with an old Edge pin) after the page reloaded, for example after an update or F5. Edge puts its own app ID back on a reload, so the page now asks the app to restore its own button and icon every time it loads. The launcher also waits up to 60 seconds (was 20) for a slow-starting browser window.

## 1.5.1 (2026-10-29)

Use the app from your phone over Tailscale.

- **Phone access** in Settings (off until you turn it on): shows this PC's Tailscale IP, the port and the address to open on the phone, plus the MagicDNS name, each with a Copy button.
- Phones pair once with a 6 digit code from **Pair a phone**. A code works once, lasts 5 minutes and dies after 5 wrong tries. Paired devices are listed with when they were last used, and **Remove** locks one out right away.
- The app only listens on the Tailscale address, never on the home network or the internet, and it answers only devices on your tailnet. Pairing controls work on the PC only.
- On a phone-sized screen the sidebar opens from a menu button, and terminals get a row of keys a phone keyboard lacks: Esc, Tab, Shift+Tab, arrows, Enter and Ctrl+C.

## 1.5.0 (2026-10-29)

Runs on macOS too. Windows works as before.

- **Built-in terminals** on a Mac use a small C pseudo terminal bridge (`native/pty-bridge.c`, same protocol as the ConPTY one), compiled on first use with the Xcode command line tools' `cc`. Sessions run in the login shell, so PATH matches a Terminal window. The session host listens on a Unix socket (mode 600) in the data folder.
- **Terminal** stands in for Windows Terminal: reopen and new session open a Terminal.app tab, the sidebar jumps to a session's tab in Terminal or iTerm2 (found by its tty), and **Move here** ends the Terminal session and continues it in the app.
- **Start at login** (a LaunchAgent) replaces Start with Windows. App data lives in `~/Library/Application Support/ClaudeSessions`.
- Cmd+C copies and Cmd+V pastes; Ctrl+C always reaches Claude; an image on the clipboard is sent as Ctrl+V, the key Claude Code reads images on in macOS.
- `scripts/build-mac.sh` builds **Claude Sessions.app** into `~/Applications`; `scripts/install-mac.sh` installs from the newest release tag, like `install.ps1`.
- The status line command quotes its paths (the Mac data folder has a space) and names node in full.
- The wiki folder list starts empty on a Mac (the default `\\Mobius\Chris` share is a Windows path).

## 1.4.1 (2026-10-29)

- **+ New session** moved from the top right to the bottom left of the sidebar, just above Settings. Its folder list opens upward.

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
