// Claude Sessions.app: the macOS window for the dashboard. It starts the server
// (node launch.js --background) and shows http://127.0.0.1:8930 in its own
// window, so the app has its own Dock icon instead of living under a browser's.
// Closing the window quits the app; the server and every session keep running.
//
// Built by scripts/build-mac.sh with swiftc. Info.plist carries the paths:
//   CSNode    node to run      CSAppDir  the app folder holding launch.js

import Cocoa
import WebKit

let port = 8930
let home = URL(string: "http://127.0.0.1:\(port)/")!

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
  var window: NSWindow!
  var web: WKWebView!

  func applicationDidFinishLaunching(_ note: Notification) {
    NSApp.mainMenu = menu()
    let cfg = WKWebViewConfiguration()
    cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
    web = WKWebView(frame: .zero, configuration: cfg)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.setValue(false, forKey: "drawsBackground") // no white flash before the page paints

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 860),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "Claude Sessions"
    window.backgroundColor = NSColor(red: 0.08, green: 0.09, blue: 0.11, alpha: 1)
    window.minSize = NSSize(width: 720, height: 480)
    window.contentView = web
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("Claude Sessions")
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    status("Starting…")
    DispatchQueue.global().async {
      let err = self.startServer()
      DispatchQueue.main.async {
        if let err = err { self.status(err) } else { self.web.load(URLRequest(url: home)) }
      }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

  // ---- server ----------------------------------------------------------------

  func info(_ key: String) -> String? { Bundle.main.object(forInfoDictionaryKey: key) as? String }

  // launch.js starts the server if it is not running and waits until it answers.
  func startServer() -> String? {
    if ping() { return nil }
    guard let dir = info("CSAppDir") else { return "This build has no app folder. Run scripts/build-mac.sh again." }
    var node = info("CSNode") ?? ""
    if !FileManager.default.isExecutableFile(atPath: node) { node = shell("command -v node") }
    if node.isEmpty { return "node was not found. Install Node 18 or newer, then open the app again." }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = [dir + "/launch.js", "--background"]
    p.currentDirectoryURL = URL(fileURLWithPath: dir)
    do { try p.run() } catch { return "Could not start the server: \(error.localizedDescription)" }
    p.waitUntilExit()
    for _ in 0..<20 { if ping() { return nil }; Thread.sleep(forTimeInterval: 0.25) }
    return "The server did not start. See ~/Library/Application Support/ClaudeSessions/data/server.log"
  }

  func ping() -> Bool {
    var req = URLRequest(url: home.appendingPathComponent("api/ping"), timeoutInterval: 1.5)
    req.cachePolicy = .reloadIgnoringLocalCacheData
    let done = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: req) { data, _, _ in
      if let d = data, let s = String(data: d, encoding: .utf8), s.contains("claude-sessions") { ok = true }
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 2)
    return ok
  }

  func shell(_ cmd: String) -> String {
    let p = Process()
    let out = Pipe()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", cmd]
    p.standardOutput = out
    try? p.run()
    p.waitUntilExit()
    return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  }

  func status(_ text: String) {
    let safe = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
    web.loadHTMLString("""
      <body style="margin:0;height:100vh;display:grid;place-items:center;background:#14171d;color:#9aa3b2;
      font:14px -apple-system,sans-serif;text-align:center;padding:0 40px">\(safe)</body>
      """, baseURL: nil)
  }

  // ---- web view ----------------------------------------------------------------

  // The dashboard stays in the window; any other link opens in the default browser.
  func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if let url = action.request.url, url.host != nil, url.host != "127.0.0.1" && url.host != "localhost" {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  // A web view ignores <input type=file> until the app shows the panel (+ Image, Add image...).
  func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let o = NSOpenPanel()
    o.canChooseFiles = true
    o.canChooseDirectories = p.allowsDirectories
    o.allowsMultipleSelection = p.allowsMultipleSelection
    o.beginSheetModal(for: window) { r in completionHandler(r == .OK ? o.urls : nil) }
  }

  // The server restarted (an update): reload once it answers again.
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.load(URLRequest(url: home)) }

  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { w.load(URLRequest(url: home)) }
  }

  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = m
    a.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = m
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
  }

  func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText: String?, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert()
    a.messageText = p
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 420, height: 24))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.window.initialFirstResponder = field
    a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  // ---- menus (Cmd+C, Cmd+V and the rest only work through an Edit menu) ----------

  @objc func reload(_ s: Any?) { web.load(URLRequest(url: home)) }

  func menu() -> NSMenu {
    let bar = NSMenu()
    func add(_ title: String, _ items: [NSMenuItem]) {
      let top = NSMenuItem()
      let m = NSMenu(title: title)
      items.forEach(m.addItem)
      top.submenu = m
      bar.addItem(top)
    }
    func item(_ t: String, _ a: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: t, action: a, keyEquivalent: k)
      i.keyEquivalentModifierMask = mods
      return i
    }
    add("Claude Sessions", [
      item("About Claude Sessions", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
      .separator(),
      item("Hide Claude Sessions", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      .separator(),
      item("Quit Claude Sessions", #selector(NSApplication.terminate(_:)), "q"),
    ])
    add("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    let reload = item("Reload", #selector(reload(_:)), "r")
    reload.target = self
    add("View", [reload])
    add("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:)), ""),
      item("Close", #selector(NSWindow.performClose(_:)), "w"),
    ])
    return bar
  }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
