# Gives the dashboard's browser app window its own taskbar button with the app's icon.
# Without this, Edge/Chrome group the window under the browser's own icon.
# Sets the window's AppUserModelID (separate taskbar group), its relaunch command,
# name and icon (what a pinned button uses), and the window icon itself.
# Paths come in through env vars: CS_ICON (the .ico), CS_RELAUNCH (command line).
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class AppWindow {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PropertyKey { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Explicit)]
  public struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr p;
    [FieldOffset(16)] public IntPtr pad;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    void GetCount(out uint c);
    void GetAt(uint i, out PropertyKey k);
    void GetValue(ref PropertyKey k, out PropVariant v);
    void SetValue(ref PropertyKey k, ref PropVariant v);
    void Commit();
  }

  [DllImport("shell32.dll")]
  static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr inst, string name, uint type, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

  static readonly Guid AUM = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

  // Top-level browser windows whose title ends in "Claude Sessions".
  public static List<IntPtr> Find() {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      var cls = new StringBuilder(64);
      GetClassName(h, cls, 64);
      if (cls.ToString() != "Chrome_WidgetWin_1") return true;
      var t = new StringBuilder(300);
      GetWindowText(h, t, 300);
      if (t.ToString().EndsWith("Claude Sessions")) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static void Set(IPropertyStore s, uint pid, string value) {
    var k = new PropertyKey { fmtid = AUM, pid = pid };
    var v = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(value) }; // VT_LPWSTR
    try { s.SetValue(ref k, ref v); } finally { Marshal.FreeCoTaskMem(v.p); }
  }

  public static void Apply(IntPtr h, string id, string relaunch, string name, string icon) {
    var iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore s;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(h, ref iid, out s));
    try {
      Set(s, 2, relaunch);   // RelaunchCommand
      Set(s, 3, icon);       // RelaunchIconResource
      Set(s, 4, name);       // RelaunchDisplayNameResource
      Set(s, 5, id);         // ID, last so the taskbar sees the rest with it
      s.Commit();
    } finally { Marshal.ReleaseComObject(s); }
    // Title bar and Alt+Tab icon. 0x10 = LR_LOADFROMFILE, 1 = IMAGE_ICON, 0x80 = WM_SETICON.
    IntPtr big = LoadImage(IntPtr.Zero, icon, 1, 48, 48, 0x10);
    IntPtr small = LoadImage(IntPtr.Zero, icon, 1, 16, 16, 0x10);
    if (big != IntPtr.Zero) SendMessage(h, 0x80, (IntPtr)1, big);
    if (small != IntPtr.Zero) SendMessage(h, 0x80, IntPtr.Zero, small);
  }
}
'@

# The window shows up a moment after the browser starts; wait up to 20 seconds for it.
$done = @{}
for ($i = 0; $i -lt 40; $i++) {
  foreach ($h in [AppWindow]::Find()) {
    if ($done.ContainsKey($h)) { continue }
    [AppWindow]::Apply($h, 'c3dprints.ClaudeSessions', $env:CS_RELAUNCH, 'Claude Sessions', $env:CS_ICON)
    $done[$h] = $true
  }
  if ($done.Count -gt 0 -and $i -ge 6) { break }
  Start-Sleep -Milliseconds 500
}
