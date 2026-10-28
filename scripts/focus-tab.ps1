# Brings the terminal tab that hosts a claude.exe process to the front.
# Inputs come from environment variables so titles with quotes cannot break parsing:
#   CS_PID    claude.exe process id
#   CS_TITLE  session title (Windows Terminal tab names contain it, after a status glyph)
# Prints one JSON line: {"ok":bool,"window":"...","tab":"..."|null,"error":"..."}
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -Namespace CS -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
'@

  $claudePid = [int]$env:CS_PID
  $title = [string]$env:CS_TITLE

  # Walk up the parent chain: claude.exe <- shell <- WindowsTerminal.exe (or another host with a window).
  $procs = @{}
  Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }
  $chain = @()
  $cur = $claudePid
  for ($i = 0; $i -lt 8 -and $procs.ContainsKey($cur); $i++) {
    $chain += $cur
    $cur = [int]$procs[$cur].ParentProcessId
  }
  if ($chain.Count -eq 0) { throw "process $claudePid is not running" }

  $AE = [System.Windows.Automation.AutomationElement]
  $root = $AE::RootElement
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)

  $target = $null
  foreach ($p in $chain) {
    $cands = @($windows | Where-Object { $_.Current.ProcessId -eq $p -and $_.Current.NativeWindowHandle -ne 0 })
    if ($cands.Count -gt 0) { $target = $cands; break }
  }
  if (-not $target) { throw 'no terminal window found for this session' }

  $tabCond = New-Object System.Windows.Automation.PropertyCondition ($AE::ControlTypeProperty), ([System.Windows.Automation.ControlType]::TabItem)
  $win = $target[0]
  $tabName = $null
  if ($title) {
    :outer foreach ($w in $target) {
      foreach ($t in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)) {
        if ($t.Current.Name -and $t.Current.Name.Contains($title)) {
          $sel = $t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
          $sel.Select()
          $win = $w
          $tabName = $t.Current.Name
          break outer
        }
      }
    }
  }

  $h = [IntPtr]$win.Current.NativeWindowHandle
  if ([CS.Win]::IsIconic($h)) { [void][CS.Win]::ShowWindow($h, 9) }
  # Windows refuses SetForegroundWindow from a background process unless a key
  # event was just seen; a bare Alt tap is the usual way past that lock.
  [CS.Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [CS.Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][CS.Win]::SetForegroundWindow($h)

  @{ ok = $true; window = $win.Current.Name; tab = $tabName } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
