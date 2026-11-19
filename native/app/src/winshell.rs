//! Windows shell helpers (port of focusWindow.ts, desktopSend.ts, stableHelper.ts): raise terminal / Claude app windows and send
//! text into the Claude desktop app through PowerShell + UI Automation, plus the stable copy of pet-helper.exe.
//! All functions block; call them off the UI thread. The PowerShell scripts are copied verbatim from the TS sources.

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::desktop::chat_link;

/// The TS template literal turns `\r` inside the script into a real CR; the raw strings keep the two characters, fixed in `script()`.
fn script(s: &str) -> String {
    s.replace("\\r", "\r")
}

const FOCUS_SCRIPT: &str = r##"
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
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  public static IntPtr Find(string m) {
    IntPtr r = IntPtr.Zero;
    EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; var sb = new StringBuilder(512); GetWindowText(h, sb, 512); if (sb.ToString().Contains(m)) { r = h; return false; } return true; }, IntPtr.Zero);
    return r;
  }
  // without the Alt trick (Alt opens the menu bar of Electron apps): minimize and restore, which Windows lets any process do
  public static void RaiseNoAlt(IntPtr h) {
    bool max = IsZoomed(h);
    if (!IsIconic(h)) ShowWindow(h, 6);
    ShowWindow(h, max ? 3 : 9);
    BringWindowToTop(h); SetForegroundWindow(h);
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
"##;

const DESKTOP_SCRIPT: &str = r##"
$ErrorActionPreference = 'Stop'

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
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  public static IntPtr Find(string m) {
    IntPtr r = IntPtr.Zero;
    EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; var sb = new StringBuilder(512); GetWindowText(h, sb, 512); if (sb.ToString().Contains(m)) { r = h; return false; } return true; }, IntPtr.Zero);
    return r;
  }
  // without the Alt trick (Alt opens the menu bar of Electron apps): minimize and restore, which Windows lets any process do
  public static void RaiseNoAlt(IntPtr h) {
    bool max = IsZoomed(h);
    if (!IsIconic(h)) ShowWindow(h, 6);
    ShowWindow(h, max ? 3 : 9);
    BringWindowToTop(h); SetForegroundWindow(h);
  }
  public static void Raise(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, 0); keybd_event(0x12, 0, 2, 0); // a synthetic Alt press lifts Windows' foreground lock for this call
    BringWindowToTop(h); SetForegroundWindow(h);
  }
}
'@

for ($i = 0; $i -lt 12; $i++) {
  $p = Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -notlike '*\.local\bin\*' } | Select-Object -First 1
  if ($p) { [PetWin]::RaiseNoAlt($p.MainWindowHandle); 'ok'; exit 0 }
  Start-Sleep -Milliseconds 250
}
'none'
"##;

const SEND_SCRIPT: &str = r##"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class PetWin {
  [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  public static uint IdleMs() { var l = new LII(); l.cbSize = 8; GetLastInputInfo(ref l); return unchecked(GetTickCount() - l.dwTime); }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint k, byte a, uint f);
  [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr h, out uint k, out byte a, out uint f);
  /** hands the foreground back: joining the input of the window that has it now is what Windows accepts from a background process */
  public static bool GiveBack(IntPtr to) {
    IntPtr fg = GetForegroundWindow();
    if (fg == to) return true;
    uint me = GetCurrentThreadId(), them = GetWindowThreadProcessId(fg, IntPtr.Zero);
    bool att = them != 0 && them != me && AttachThreadInput(me, them, true);
    try { BringWindowToTop(to); SetForegroundWindow(to); } finally { if (att) AttachThreadInput(me, them, false); }
    return GetForegroundWindow() == to;
  }
}
'@
$A = [Windows.Automation.AutomationElement]; $S = [Windows.Automation.TreeScope]::Descendants
function Win { Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -notlike '*\.local\bin\*' } | Select-Object -First 1 }
$LAYERED = 0x80000; $NOREDIR = 0x200000
# safety net (also run by the pet after a failed or killed attempt, and once when it starts): a window we left invisible is made visible again
if ($env:PET_MODE -eq 'unhide') {
  $w = Win
  if ($w) {
    $h = $w.MainWindowHandle; $ex = [PetWin]::GetWindowLong($h, -20)
    $k = 0; $al = [byte]0; $f = 0
    if (($ex -band $LAYERED) -ne 0 -and [PetWin]::GetLayeredWindowAttributes($h, [ref]$k, [ref]$al, [ref]$f) -and ($f -band 2) -ne 0 -and ($al -eq 0 -or (($ex -band $NOREDIR) -ne 0 -and $al -eq 255))) {
      [void][PetWin]::SetLayeredWindowAttributes($h, 0, 255, 2); [void][PetWin]::SetWindowLong($h, -20, ($ex -band (-bnot $LAYERED))); 'unhidden'
    }
  }
  'ok'; exit 0
}
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PET_TEXT))
$title = if ($env:PET_TITLE) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PET_TITLE)) } else { '' }
function ByType($root, $t) { $root.FindAll($S, (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, $t))) }
function ChatShown($root) { foreach ($d in (ByType $root ([Windows.Automation.ControlType]::Document))) { if ($d.Current.Name.StartsWith($title + ' - ')) { return $true } } return $false }
# never in the middle of the user's own typing or mouse work: wait for a short pause in the input (at most a minute)
for ($i = 0; $i -lt 600 -and [PetWin]::IdleMs() -lt 700; $i++) { Start-Sleep -Milliseconds 100 }
$prev = [PetWin]::GetForegroundWindow()
$p = Win
$wasIcon = $false; $hidden = $false; $h = [IntPtr]::Zero; $exOrig = 0; $layOrig = $null
if ($p) { $wasIcon = [PetWin]::IsIconic($p.MainWindowHandle) }
# the app's window is made fully transparent while the pet works in it, so nothing flashes on the screen
function Hide {
  if ($script:hidden -or -not $script:p) { return }
  $script:h = $script:p.MainWindowHandle
  $script:exOrig = [PetWin]::GetWindowLong($script:h, -20)
  if (($script:exOrig -band $LAYERED) -ne 0) {
    $k = 0; $al = [byte]0; $f = 0
    # a window that draws itself with per-pixel alpha (no attributes to read back) is left alone: it simply is not hidden
    if (-not [PetWin]::GetLayeredWindowAttributes($script:h, [ref]$k, [ref]$al, [ref]$f)) { return }
    # Chromium draws without a redirection bitmap and is never layered by itself: a fully opaque layered flag is one an
    # interrupted earlier attempt left behind (it garbles the window), so the window is given back without it
    if (($script:exOrig -band $NOREDIR) -ne 0 -and ($f -band 2) -ne 0 -and $al -eq 255) { $script:exOrig = $script:exOrig -band (-bnot $LAYERED) }
    else { $script:layOrig = @($k, $al, $f) }
  }
  else { [void][PetWin]::SetWindowLong($script:h, -20, ($script:exOrig -bor $LAYERED)) }
  [void][PetWin]::SetLayeredWindowAttributes($script:h, 0, 0, 2)
  $script:hidden = $true
}
function Unhide {
  if (-not $script:hidden) { return }
  if ($script:layOrig) { [void][PetWin]::SetLayeredWindowAttributes($script:h, [uint32]$script:layOrig[0], [byte]$script:layOrig[1], [uint32]$script:layOrig[2]) }
  else { [void][PetWin]::SetLayeredWindowAttributes($script:h, 0, 255, 2); [void][PetWin]::SetWindowLong($script:h, -20, $script:exOrig) }
  $script:hidden = $false
}
# a minimized Chromium window does not render: the prompt ignores the text and the Send button never shows up.
# While invisible it is restored without activation, and minimized again before it becomes visible
function Restore {
  if (-not $script:p -or -not [PetWin]::IsIconic($script:p.MainWindowHandle)) { return }
  Hide
  [void][PetWin]::ShowWindow($script:p.MainWindowHandle, 4)
  for ($i = 0; $i -lt 40 -and [PetWin]::IsIconic($script:p.MainWindowHandle); $i++) { Start-Sleep -Milliseconds 25 }
  Start-Sleep -Milliseconds 120
}
function ReMin { if ($script:p -and $wasIcon -and -not [PetWin]::IsIconic($script:p.MainWindowHandle)) { [void][PetWin]::ShowWindow($script:p.MainWindowHandle, 7) } }
function GiveBack {
  if (-not $script:p) { return }
  if ($prev -ne [IntPtr]::Zero -and $prev -ne $script:p.MainWindowHandle) { [void][PetWin]::GiveBack($prev) }
}
$stolenMs = -1
function Main {
  $already = $false
  if ($p -and $title -and $env:PET_LINK) { try { $already = ChatShown ($A::FromHandle($p.MainWindowHandle)) } catch { $already = $false } }
  if ($env:PET_LINK -and -not $already) { Hide; Start-Process $env:PET_LINK }
  if (-not $already) { for ($i = 0; $i -lt 120 -and -not $script:p; $i++) { $script:p = Win; if (-not $script:p) { Start-Sleep -Milliseconds 100 } }; Hide }
  if (-not $script:p) { return 'no-window' }
  Restore
  $root = $A::FromHandle($script:p.MainWindowHandle)
  if ($title -and -not $already) {
    $ok = $false
    for ($i = 0; $i -lt 100 -and -not $ok; $i++) { $ok = ChatShown $root; if (-not $ok) { Start-Sleep -Milliseconds 100 } }
    if (-not $ok) { return 'wrong-chat' }
  }
  # the app asks before it works in a new folder; that question is the user's alone to answer, the pet never presses it
  function Trust { foreach ($b in (ByType $root ([Windows.Automation.ControlType]::Button))) { if ($b.Current.Name -match '^(Доверять рабочей области|Trust|Trust this workspace|Trust workspace|信任)') { return $true } } return $false }
  function FindEdit { foreach ($e in (ByType $root ([Windows.Automation.ControlType]::Edit))) { if ($e.Current.ClassName -like '*ProseMirror*') { return $e } } return $null }
  $ed = $null
  for ($i = 0; $i -lt 100 -and -not $ed; $i++) { $ed = FindEdit; if (-not $ed) { Start-Sleep -Milliseconds 100 } }
  if (-not $ed) { if (Trust) { return 'needs-trust' } else { return 'no-input' } }
  $vp = $ed.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
  $norm = { param($v) ($v -replace "\r", '').Trim() }
  $want = & $norm $text
  $prefilled = $env:PET_PREFILLED -eq '1'
  # unsent text the user has typed in that chat is theirs: it is never overwritten
  if (-not $prefilled -and (& $norm $vp.Current.Value) -ne '') { return 'busy' }
  # the Send button lives next to the prompt box: search there, not in the whole page (much faster)
  $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
  $near = $ed; for ($i = 0; $i -lt 6; $i++) { $up = $walker.GetParent($near); if ($up) { $near = $up } }
  $sendName = '^(Отправить|Send|Send message|发送|发送消息)$'
  $stopName = '^(Остановить|Stop|Stop response|停止|停止响应)$'
  function FindSend {
    $busy = $false
    foreach ($scope in @($near, $root)) { foreach ($b in (ByType $scope ([Windows.Automation.ControlType]::Button))) { $n = $b.Current.Name; if ($n -match $sendName) { return $b } elseif ($n -match $stopName) { $busy = $true } } }
    if ($busy) { return 'busy' }; return $null
  }
  Hide
  # the only moment the app holds the keyboard: setting the text focuses the prompt box (Chromium does that); the focus goes back as soon as the text is in
  $sw = [Diagnostics.Stopwatch]::StartNew()
  if (-not $prefilled) { $vp.SetValue($text) }
  $same = $false
  for ($i = 0; $i -lt ($(if ($prefilled) { 600 } else { 150 })) -and -not $same; $i++) { $same = ((& $norm $vp.Current.Value) -eq $want); if (-not $same) { Start-Sleep -Milliseconds 10 } }
  GiveBack
  $script:stolenMs = $sw.ElapsedMilliseconds
  if (-not $same) { if (-not $prefilled) { try { $vp.SetValue('') } catch {} }; if (Trust) { return 'needs-trust' } else { return 'mismatch' } }
  $send = $null
  for ($i = 0; $i -lt 30 -and -not ($send -is [Windows.Automation.AutomationElement]); $i++) { $send = FindSend; if (-not ($send -is [Windows.Automation.AutomationElement])) { Start-Sleep -Milliseconds 50 } }
  if (-not ($send -is [Windows.Automation.AutomationElement])) { if (-not $prefilled) { try { $vp.SetValue('') } catch {} }; GiveBack; if ($send -eq 'busy') { return 'busy' } else { return 'no-send' } }
  $send.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  GiveBack # pressing Send through UI Automation may focus the window again
  Start-Sleep -Milliseconds 150
  return 'ok'
}
$result = 'error'
try { $result = Main } finally { ReMin; Unhide; GiveBack }
"stolen=$stolenMs"
$result
"##;


/// Base64 of the UTF-16LE script, as `-EncodedCommand` wants it.
fn encode_script(s: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Runs a script in powershell.exe; Some(stdout) only for a clean exit within the timeout (like execFile without `err`).
fn run_ps(script_text: &str, env: &[(&str, String)], timeout: Duration) -> Option<String> {
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encode_script(script_text)])
        .envs(env.iter().map(|(k, v)| (*k, v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let start = Instant::now();
    let ok = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.success(),
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let out = reader.join().unwrap_or_default();
    ok.then(|| String::from_utf8_lossy(&out).into_owned())
}

fn ends_ok(out: Option<String>) -> bool {
    out.is_some_and(|o| o.trim().ends_with("ok"))
}

/// Brings the terminal window/tab whose title contains `title` to the front. True when one was found.
pub fn focus_by_title(title: &str) -> bool {
    ends_ok(run_ps(&script(FOCUS_SCRIPT), &[("PET_MARK", title.to_string())], Duration::from_millis(12_000)))
}

/// Brings the Claude desktop app's window to the front (after a claude:// link opened a chat in it).
pub fn focus_desktop_app() -> bool {
    ends_ok(run_ps(&script(DESKTOP_SCRIPT), &[], Duration::from_millis(10_000)))
}

pub const SEND_RESULTS: [&str; 8] = ["ok", "no-window", "no-input", "wrong-chat", "busy", "no-send", "mismatch", "needs-trust"];

/// Last non-empty-trimmed line of the script output when it is a known result, else "error".
pub fn parse_send_result(out: &str) -> String {
    let last = out.trim().lines().last().map(str::trim).unwrap_or("");
    if SEND_RESULTS.contains(&last) { last.to_string() } else { "error".into() }
}

fn b64(s: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}

/// Environment of a send script (text/title base64 of UTF-8, link, prefilled flag).
fn send_env(text: &str, title: Option<&str>, link: Option<&str>, prefilled: bool) -> Vec<(&'static str, String)> {
    vec![
        ("PET_TEXT", b64(text)),
        ("PET_TITLE", title.filter(|t| !t.is_empty()).map(b64).unwrap_or_default()),
        ("PET_LINK", link.unwrap_or("").to_string()),
        ("PET_PREFILLED", if prefilled { "1".into() } else { String::new() }),
    ]
}

static SEND_LOCK: Mutex<()> = Mutex::new(());

/// Sends a message into a chat of the Claude desktop app through UI Automation. One send at a time. Returns one of
/// SEND_RESULTS or "error". `prefill_link` (a new chat) makes the app fill the prompt itself.
pub fn send_to_desktop(text: &str, title: Option<&str>, desktop_id: Option<&str>, prefill_link: Option<&str>) -> String {
    let _g = SEND_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let link = prefill_link.map(str::to_string).or_else(|| desktop_id.and_then(chat_link));
    let env = send_env(text, title, link.as_deref(), prefill_link.is_some());
    let r = run_ps(&script(SEND_SCRIPT), &env, Duration::from_millis(150_000)).map_or_else(|| "error".to_string(), |o| parse_send_result(&o));
    if r != "ok" {
        unhide_desktop(); // a killed or failed attempt must never leave the app's window invisible
    }
    r
}

/// Makes the Claude app's window visible again if a send left it transparent.
pub fn unhide_desktop() {
    let _ = run_ps(&script(SEND_SCRIPT), &[("PET_MODE", "unhide".to_string())], Duration::from_millis(15_000));
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct HelperSync {
    pub path: Option<String>,
    pub error: Option<String>,
    pub updated: bool,
}

fn default_replace(src: &Path, dst: &Path) -> std::io::Result<()> {
    let mut tmp = dst.as_os_str().to_owned();
    tmp.push(".new");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::copy(src, &tmp)?;
    std::fs::rename(&tmp, dst).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

fn sync_with(installed: &Path, dir: &Path, replace: &dyn Fn(&Path, &Path) -> std::io::Result<()>) -> HelperSync {
    if !installed.exists() {
        return HelperSync::default();
    }
    let dst = dir.join("pet-helper.exe");
    let have = dst.exists();
    let s = |p: &Path| Some(p.to_string_lossy().into_owned());
    let attempt = || -> std::io::Result<bool> {
        if have && std::fs::read(&dst)? == std::fs::read(installed)? {
            return Ok(false);
        }
        std::fs::create_dir_all(dir)?;
        replace(installed, &dst)?;
        Ok(true)
    };
    match attempt() {
        Ok(updated) => HelperSync { path: s(&dst), error: None, updated },
        // in use by running sessions: keep the old copy; no copy at all: use the installed one
        Err(e) => HelperSync { path: if have { s(&dst) } else { s(installed) }, error: Some(e.to_string()), updated: false },
    }
}

/// pet-helper.exe runs as long as a Claude Code session lives, so hooks point at a stable copy in `dir` (%LOCALAPPDATA%\ccPet\bin),
/// refreshed whenever the file is free.
pub fn sync_helper(installed: &Path, dir: &Path) -> HelperSync {
    sync_with(installed, dir, &default_replace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup(content: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("winshell-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        fs::create_dir_all(d.join("install")).unwrap();
        let src = d.join("install").join("pet-helper.exe");
        fs::write(&src, content).unwrap();
        (d.clone(), src, d.join("bin"))
    }

    #[test]
    fn parses_last_line_of_output() {
        assert_eq!(parse_send_result("ok\r\n"), "ok");
        assert_eq!(parse_send_result("noise\nbusy"), "busy");
        assert_eq!(parse_send_result("wrong-chat"), "wrong-chat");
        assert_eq!(parse_send_result("stolen=5\nneeds-trust\r\n"), "needs-trust");
        assert_eq!(parse_send_result(""), "error");
        assert_eq!(parse_send_result("Exception: boom"), "error");
    }

    #[test]
    fn script_encoding_and_cr() {
        assert_eq!(encode_script("ab"), "YQBiAA==");
        let s = script(SEND_SCRIPT);
        assert!(s.contains("-replace \"\r\", ''"));
        assert!(s.contains("*\\.local\\bin\\*"));
        assert!(script(FOCUS_SCRIPT).contains("Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes\n\nAdd-Type @'"));
        assert!(script(DESKTOP_SCRIPT).contains("public class PetWin"));
    }

    #[test]
    fn send_env_encoding() {
        let e = send_env("привет", Some("T"), Some("claude://x"), true);
        assert_eq!(e[0], ("PET_TEXT", b64("привет")));
        assert_eq!(e[1], ("PET_TITLE", "VA==".to_string()));
        assert_eq!(e[2].1, "claude://x");
        assert_eq!(e[3].1, "1");
        let e = send_env("a", None, None, false);
        assert_eq!((e[1].1.as_str(), e[2].1.as_str(), e[3].1.as_str()), ("", "", ""));
    }

    #[test]
    fn helper_first_copy_and_update() {
        let (d, src, dir) = setup("v1");
        let r = sync_helper(&src, &dir);
        let dst = dir.join("pet-helper.exe");
        assert_eq!(r, HelperSync { path: Some(dst.to_string_lossy().into_owned()), error: None, updated: true });
        assert_eq!(fs::read_to_string(&dst).unwrap(), "v1");
        assert!(!sync_helper(&src, &dir).updated);
        fs::write(&src, "v2").unwrap();
        assert!(sync_helper(&src, &dir).updated);
        assert_eq!(fs::read_to_string(&dst).unwrap(), "v2");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn helper_busy_keeps_old_copy_and_falls_back_to_installed() {
        let (d, src, dir) = setup("v1");
        sync_helper(&src, &dir);
        fs::write(&src, "v2").unwrap();
        let busy = |_: &Path, _: &Path| Err(std::io::Error::other("busy"));
        let r = sync_with(&src, &dir, &busy);
        assert_eq!(r.path, Some(dir.join("pet-helper.exe").to_string_lossy().into_owned()));
        assert!(!r.updated);
        assert!(r.error.unwrap().contains("busy"));
        assert_eq!(fs::read_to_string(dir.join("pet-helper.exe")).unwrap(), "v1");
        let (d2, src2, dir2) = setup("v1");
        let r = sync_with(&src2, &dir2, &|_, _| Err(std::io::Error::other("denied")));
        assert_eq!(r.path, Some(src2.to_string_lossy().into_owned()));
        assert!(!dir2.join("pet-helper.exe").exists());
        let _ = fs::remove_dir_all(d);
        let _ = fs::remove_dir_all(d2);
    }

    #[test]
    fn helper_missing_installed() {
        let (d, _, dir) = setup("v1");
        assert_eq!(sync_helper(&d.join("nope.exe"), &dir).path, None);
        let _ = fs::remove_dir_all(d);
    }
}
