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
$A = [Windows.Automation.AutomationElement]; $S = [Windows.Automation.TreeScope]::Descendants
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PET_TEXT))
$title = if ($env:PET_TITLE) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PET_TITLE)) } else { '' }
function Win { Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -notlike '*\\.local\\bin\\*' } | Select-Object -First 1 }
function ByType($root, $t) { $root.FindAll($S, (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, $t))) }
if ($env:PET_LINK) { Start-Process $env:PET_LINK }
$p = $null
for ($i = 0; $i -lt 60 -and -not $p; $i++) { $p = Win; if (-not $p) { Start-Sleep -Milliseconds 250 } }
if (-not $p) { 'no-window'; exit 0 }
$root = $A::FromHandle($p.MainWindowHandle)
# the chat in front is the one that was asked for (the page title is \"<chat> - <app>\")
if ($title) {
  $ok = $false
  for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
    foreach ($d in (ByType $root ([Windows.Automation.ControlType]::Document))) { if ($d.Current.Name.StartsWith($title + ' - ')) { $ok = $true; break } }
    if (-not $ok) { Start-Sleep -Milliseconds 250 }
  }
  if (-not $ok) { 'wrong-chat'; exit 0 }
}
# the app asks before it works in a new folder; that question is the user's alone to answer, the pet never presses it
function Trust { foreach ($b in (ByType $root ([Windows.Automation.ControlType]::Button))) { if ($b.Current.Name -match '^(Доверять рабочей области|Trust|Trust this workspace|Trust workspace|信任)') { return $true } } return $false }
function FindEdit { foreach ($e in (ByType $root ([Windows.Automation.ControlType]::Edit))) { if ($e.Current.ClassName -like '*ProseMirror*') { return $e } } return $null }
$ed = $null
for ($i = 0; $i -lt 40 -and -not $ed; $i++) { $ed = FindEdit; if (-not $ed) { Start-Sleep -Milliseconds 250 } }
if (-not $ed) { if (Trust) { 'needs-trust' } else { 'no-input' }; exit 0 }
$norm = { param($s) ($s -replace "\`r", '').Trim() }
$val = { try { $x = FindEdit; if ($x) { $script:ed = $x; & $norm $script:ed.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value } } catch { '' } }
# a new chat opened with ?q= is filled in by the app itself: only send once the prompt holds exactly that text (never into a chat that was already open)
$prefilled = $env:PET_PREFILLED -eq '1'
if (-not $prefilled) { $vp = $ed.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern); $vp.SetValue(''); Start-Sleep -Milliseconds 250; $vp.SetValue($text) }
$same = $false
for ($i = 0; $i -lt ($(if ($prefilled) { 48 } else { 12 })) -and -not $same; $i++) { Start-Sleep -Milliseconds 250; $same = ((& $val) -eq (& $norm $text)) }
if (-not $same) { if (-not $prefilled) { try { $ed.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue('') } catch {} }; $(if (Trust) { 'needs-trust' } else { 'mismatch' }); exit 0 }
$sendName = '^(Отправить|Send|Send message|发送|发送消息)$'
$stopName = '^(Остановить|Stop|Stop response|停止|停止响应)$'
$send = $null; $busy = $false
for ($i = 0; $i -lt 12 -and -not $send; $i++) {
  foreach ($b in (ByType $root ([Windows.Automation.ControlType]::Button))) {
    $n = $b.Current.Name
    if ($n -match $sendName) { $send = $b; break } elseif ($n -match $stopName) { $busy = $true }
  }
  if (-not $send) { Start-Sleep -Milliseconds 250 }
}
if (-not $send) { if (-not $prefilled) { try { $ed.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue('') } catch {} }; if ($busy) { 'busy' } else { 'no-send' }; exit 0 }
$send.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
'ok'
`;

let queue: Promise<unknown> = Promise.resolve();

/** One send at a time: two scripts driving the same prompt box would mix the texts. */
export function sendToDesktop(o: { text: string; title?: string; desktopId?: string; /** a link that makes the app fill the prompt itself (a new chat) */ prefillLink?: string }, timeoutMs = 60_000): Promise<DesktopSendResult> {
  const run = () => new Promise<DesktopSendResult>((resolve) => {
    const link = o.prefillLink ?? (o.desktopId ? chatLink(o.desktopId) : null);
    const enc = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const env = { ...process.env, PET_TEXT: Buffer.from(o.text, 'utf8').toString('base64'), PET_TITLE: o.title ? Buffer.from(o.title, 'utf8').toString('base64') : '', PET_LINK: link ?? '', PET_PREFILLED: o.prefillLink ? '1' : '' };
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true, timeout: timeoutMs, env }, (err, out) => resolve(err ? 'error' : parseSendResult(out)));
  });
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
