import { execFile } from 'node:child_process';

/**
 * Sends a message into a chat of the Claude desktop app as a real user message (it shows as "You said: ...", unlike a mailbox hook,
 * which the app draws as faint hook feedback). The chat is opened with its own deep link, the text goes into the prompt box and the
 * Send button is pressed, all through Windows UI Automation: the app is never typed into blindly. Anything unexpected (no window, no
 * prompt box, another chat in front, the session busy, the text not accepted) is reported and nothing is sent.
 */
export type DesktopSendResult = 'ok' | 'no-window' | 'no-input' | 'wrong-chat' | 'busy' | 'no-send' | 'mismatch' | 'needs-trust' | 'error';

const RESULTS: DesktopSendResult[] = ['ok', 'no-window', 'no-input', 'wrong-chat', 'busy', 'no-send', 'mismatch', 'needs-trust'];

export const parseSendResult = (out: string): DesktopSendResult => {
  const last = String(out).trim().split(/\r?\n/).pop()?.trim() ?? '';
  return (RESULTS as string[]).includes(last) ? (last as DesktopSendResult) : 'error';
};

/** claude://code/new with the text and the folder: the app opens a new chat with the prompt filled in (it does not send it). */
export const newChatLink = (folder: string, text: string): string | null => /^[A-Za-z]:\\/.test(folder) ? `claude://code/new?q=${encodeURIComponent(text)}&folder=${encodeURIComponent(folder)}` : null;

/** Only a claude:// link of the chat itself is ever opened. */
export const chatLink = (desktopId: string): string | null => /^local_[0-9A-Za-z-]{8,64}$/.test(desktopId) ? `claude://code/continue?session=${encodeURIComponent(desktopId)}` : null;

const SCRIPT = `
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
function Win { Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -notlike '*\\.local\\bin\\*' } | Select-Object -First 1 }
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
`;

let queue: Promise<unknown> = Promise.resolve();

/** One send at a time: two scripts driving the same prompt box would mix the texts. */
export function sendToDesktop(o: { text: string; title?: string; desktopId?: string; /** a link that makes the app fill the prompt itself (a new chat) */ prefillLink?: string }, timeoutMs = 150_000): Promise<DesktopSendResult> {
  const run = () => new Promise<DesktopSendResult>((resolve) => {
    const link = o.prefillLink ?? (o.desktopId ? chatLink(o.desktopId) : null);
    const enc = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const env = { ...process.env, PET_TEXT: Buffer.from(o.text, 'utf8').toString('base64'), PET_TITLE: o.title ? Buffer.from(o.title, 'utf8').toString('base64') : '', PET_LINK: link ?? '', PET_PREFILLED: o.prefillLink ? '1' : '' };
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true, timeout: timeoutMs, env }, (err, out) => {
      const r = err ? 'error' : parseSendResult(out);
      if (r !== 'ok') void unhideDesktop(); // a killed or failed attempt must never leave the app's window invisible
      resolve(r);
    });
  });
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** Makes the Claude app's window visible again if a send left it transparent (the script was killed, or the pet crashed mid-way). */
export function unhideDesktop(timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve) => {
    const enc = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true, timeout: timeoutMs, env: { ...process.env, PET_MODE: 'unhide' } }, () => resolve());
  });
}
