import { execFile } from 'node:child_process';

/** PowerShell: raises the window whose title contains the marker; or, in Windows Terminal, selects the tab with that title and raises its window. */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public class PetWin {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, int f, int e);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  public static IntPtr Find(string m) {
    IntPtr r = IntPtr.Zero;
    EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; var sb = new StringBuilder(512); GetWindowText(h, sb, 512); if (sb.ToString().Contains(m)) { r = h; return false; } return true; }, IntPtr.Zero);
    return r;
  }
  public static void Raise(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, 0); keybd_event(0x12, 0, 2, 0); // a synthetic Alt press lifts Windows' foreground lock for this call
    BringWindowToTop(h); SetForegroundWindow(h);
  }
}
'@
$m = $env:PET_MARK
if (-not $m) { "none"; exit 0 }
$root = [Windows.Automation.AutomationElement]::RootElement
$cond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
for ($i = 0; $i -lt 10; $i++) {
  $h = [PetWin]::Find($m)
  if ($h -ne [IntPtr]::Zero) { [PetWin]::Raise($h); 'ok'; exit 0 }
  foreach ($t in $root.FindAll([Windows.Automation.TreeScope]::Descendants, $cond)) {
    if ($t.Current.Name -notlike "*$m*") { continue }
    try { $t.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch {}
    $w = $t; $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    while ($w -ne $null -and $w.Current.NativeWindowHandle -eq 0) { $w = $walker.GetParent($w) }
    if ($w -ne $null) { [PetWin]::Raise([IntPtr]$w.Current.NativeWindowHandle); 'ok'; exit 0 }
  }
  Start-Sleep -Milliseconds 250
}
'none'
`;

/** Brings the terminal window/tab whose title contains `mark` to the front. Resolves true when one was found. */
export function focusByTitle(mark: string, timeoutMs = 12000): Promise<boolean> {
  return new Promise((resolve) => {
    const enc = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true, timeout: timeoutMs, env: { ...process.env, PET_MARK: mark } }, (err, out) => {
      resolve(!err && String(out).trim().endsWith('ok'));
    });
  });
}
