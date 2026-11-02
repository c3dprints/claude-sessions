// ClaudeSessionsSetup.exe: a double-click installer for Windows.
// Checks for Node.js and git (offers to install them with winget), warns when
// Claude Code is missing, then runs the install.ps1 embedded in this exe,
// which clones the app, checks out the newest release and makes the shortcut.
// Built by scripts/build-setup.js with the csc.exe that ships with Windows.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

static class Setup {
  static int Main() {
    Console.Title = "Claude Sessions setup";
    Console.WriteLine("Claude Sessions setup");
    Console.WriteLine();
    try {
      return Run();
    } catch (Exception e) {
      Console.WriteLine();
      Console.WriteLine("Setup stopped: " + e.Message);
      return Done(1);
    }
  }

  static int Run() {
    RefreshPath();
    bool node = Find("node.exe") != null, git = Find("git.exe") != null;
    if (!node || !git) {
      string missing = !node && !git ? "Node.js and Git" : !node ? "Node.js" : "Git";
      Console.WriteLine(missing + (!node && !git ? " are" : " is") + " needed and not installed.");
      if (Find("winget.exe") == null) {
        Console.WriteLine("Install it from https://nodejs.org (LTS) and https://git-scm.com, then run this setup again.");
        return Done(1);
      }
      if (!Ask("Install " + missing + " now with winget?")) return Done(1);
      if (!node) Winget("OpenJS.NodeJS.LTS");
      if (!git) Winget("Git.Git");
      RefreshPath();
      if (Find("node.exe") == null || Find("git.exe") == null) {
        Console.WriteLine("Still not found. Restart the computer, then run this setup again.");
        return Done(1);
      }
    }
    string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    if (Find("claude.exe") == null && Find("claude.cmd") == null && !File.Exists(Path.Combine(home, @".local\bin\claude.exe"))) {
      Console.WriteLine("Claude Code was not found. The app shows and runs Claude Code sessions, so install it too:");
      Console.WriteLine("  https://docs.claude.com/en/docs/claude-code/setup");
      if (!Ask("Install Claude Sessions anyway?")) return Done(1);
    }

    string dir = Path.Combine(Path.GetTempPath(), "ClaudeSessionsSetup");
    Directory.CreateDirectory(dir);
    string script = Path.Combine(dir, "install.ps1");
    using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("install.ps1"))
    using (FileStream f = File.Create(script)) s.CopyTo(f);

    Console.WriteLine("Installing...");
    int code = Exec(Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
      "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"");
    try { File.Delete(script); } catch { }
    if (code != 0) {
      Console.WriteLine("The installer reported an error (exit code " + code + ").");
      return Done(code);
    }
    Console.WriteLine();
    Console.WriteLine("Done. Claude Sessions is open, and the Desktop shortcut starts it from now on.");
    Console.WriteLine("It updates itself, so you only need this setup again to repair the install.");
    return Done(0);
  }

  static void Winget(string id) {
    Console.WriteLine("Installing " + id + "...");
    int code = Exec("winget.exe", "install --exact --id " + id);
    if (code != 0) Console.WriteLine("winget exit code " + code + ".");
  }

  static int Exec(string file, string args) {
    var p = Process.Start(new ProcessStartInfo(file, args) { UseShellExecute = false });
    p.WaitForExit();
    return p.ExitCode;
  }

  // winget changes PATH in the registry; read it again so new tools are found.
  static void RefreshPath() {
    string m = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.Machine) ?? "";
    string u = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User) ?? "";
    Environment.SetEnvironmentVariable("Path", m + ";" + u);
  }

  static string Find(string exe) {
    foreach (string d in (Environment.GetEnvironmentVariable("Path") ?? "").Split(';')) {
      if (d.Trim().Length == 0) continue;
      try {
        string p = Path.Combine(Environment.ExpandEnvironmentVariables(d.Trim()), exe);
        if (File.Exists(p)) return p;
      } catch (ArgumentException) { }
    }
    return null;
  }

  static bool Ask(string q) {
    Console.Write(q + " [Y/n] ");
    string a = (Console.ReadLine() ?? "").Trim().ToLowerInvariant();
    return a == "" || a == "y" || a == "yes";
  }

  static int Done(int code) {
    Console.WriteLine();
    Console.Write("Press Enter to close.");
    Console.ReadLine();
    return code;
  }
}
