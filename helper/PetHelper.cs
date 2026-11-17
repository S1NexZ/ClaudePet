// pet-helper.exe: small native helper of ccPet (no runtime to install: compiled with the .NET Framework that ships with Windows).
//   pet-helper.exe wait <mailboxUrl>   the mailbox waiter: an `asyncRewake` hook of Claude Code.
//     Reads the hook JSON from stdin (session_id), long-polls <mailboxUrl>/<session_id>. A message (HTTP 200) is written to stderr and the
//     process exits with code 2: Claude Code then wakes the session with that text. Everything else (no pet, 409 = another waiter,
//     the claude process is gone) exits 0 quietly. When started by `pet-helper.exe pty` the poll carries `?pty=<pipe>` so the pet can type into that session.
//   pet-helper.exe pty <command...>    runs the command (e.g. claude) on a ConPTY and shares it with the pet: the terminal window keeps working as usual,
//     and the pet can type or press Esc through the named pipe \\.\pipe\claude-pet-<pid> (exported to the child as PET_PTY_SOCK).
using System;
using Microsoft.Win32.SafeHandles;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

static class PetHelper
{
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION { public IntPtr Reserved1; public IntPtr PebBaseAddress; public IntPtr Reserved2_0; public IntPtr Reserved2_1; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId; }

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, ref PROCESS_BASIC_INFORMATION info, int size, out int returned);

    static int ParentPid()
    {
        try
        {
            var pbi = new PROCESS_BASIC_INFORMATION(); int ret;
            if (NtQueryInformationProcess(Process.GetCurrentProcess().Handle, 0, ref pbi, Marshal.SizeOf(pbi), out ret) == 0) return pbi.InheritedFromUniqueProcessId.ToInt32();
        }
        catch { }
        return 0;
    }

    static bool Alive(int pid)
    {
        if (pid <= 0) return true; // unknown parent: keep waiting
        try { return !Process.GetProcessById(pid).HasExited; } catch { return false; }
    }

    [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess")]
    static extern int NtQueryInformationProcessBuf(IntPtr handle, int infoClass, IntPtr buf, int size, out int returned);

    /** Command line of a process (ProcessCommandLineInformation, Windows 8.1+); null when it cannot be read. */
    static string CommandLineOf(int pid)
    {
        try
        {
            using (var p = Process.GetProcessById(pid))
            {
                int len;
                NtQueryInformationProcessBuf(p.Handle, 60, IntPtr.Zero, 0, out len);
                if (len <= 0 || len > 1 << 20) return null;
                IntPtr buf = Marshal.AllocHGlobal(len);
                try
                {
                    if (NtQueryInformationProcessBuf(p.Handle, 60, buf, len, out len) != 0) return null;
                    int bytes = (ushort)Marshal.ReadInt16(buf);
                    IntPtr str = Marshal.ReadIntPtr(buf, IntPtr.Size); // UNICODE_STRING { ushort Length, MaximumLength; (padding) PWSTR Buffer }
                    return Marshal.PtrToStringUni(str, bytes / 2);
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
        }
        catch { return null; }
    }

    static int ParentOf(int pid)
    {
        try
        {
            using (var p = Process.GetProcessById(pid))
            {
                var pbi = new PROCESS_BASIC_INFORMATION(); int ret;
                if (NtQueryInformationProcess(p.Handle, 0, ref pbi, Marshal.SizeOf(pbi), out ret) == 0) return pbi.InheritedFromUniqueProcessId.ToInt32();
            }
        }
        catch { }
        return 0;
    }

    /** `claude -p "..."` (print mode, not a stream-json session like the desktop app's): it waits for async hooks before exiting, so no waiter there. */
    public static bool IsOneShot(string cmd)
    {
        if (string.IsNullOrEmpty(cmd)) return false;
        bool print = Regex.IsMatch(cmd, "(^|\\s)(-p|--print)(=|\\s|$)");
        bool streamIn = Regex.IsMatch(cmd, "--input-format(=|\\s+)\"?stream-json");
        return print && !streamIn;
    }

    static bool OneShotParent(int pid)
    {
        for (int i = 0; i < 3 && pid > 0; i++)
        {
            if (IsOneShot(CommandLineOf(pid))) return true;
            pid = ParentOf(pid);
        }
        return false;
    }

    static int Wait(string baseUrl)
    {
        string json;
        try { json = Console.In.ReadToEnd(); } catch { return 0; }
        var m = Regex.Match(json, "\"session_id\"\\s*:\\s*\"([A-Za-z0-9_-]{1,100})\"");
        if (!m.Success || !baseUrl.StartsWith("http://127.0.0.1:")) return 0;
        var url = baseUrl.TrimEnd('/') + "/" + m.Groups[1].Value;
        var pipe = Environment.GetEnvironmentVariable("PET_PTY_SOCK");
        if (!string.IsNullOrEmpty(pipe) && pipe.StartsWith("\\\\.\\pipe\\claude-pet-")) url += "?pty=" + Uri.EscapeDataString(pipe);
        int parent = ParentPid();
        if (OneShotParent(parent)) return 0;
        while (Alive(parent))
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 70000; req.ReadWriteTimeout = 70000; req.Proxy = null; req.KeepAlive = false;
                using (var res = (HttpWebResponse)req.GetResponse())
                {
                    if (res.StatusCode == HttpStatusCode.OK)
                    {
                        string body;
                        using (var rd = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) body = rd.ReadToEnd();
                        if (body.Length > 0)
                        {
                            var bytes = new UTF8Encoding(false).GetBytes(body);
                            using (var err = Console.OpenStandardError()) { err.Write(bytes, 0, bytes.Length); err.Flush(); }
                            return 2;
                        }
                    }
                    // 204: nothing yet, poll again
                }
            }
            catch (WebException e)
            {
                var r = e.Response as HttpWebResponse;
                if (r != null && r.StatusCode == HttpStatusCode.NoContent) continue;
                return 0; // 409, 404, connection refused (the pet is not running), timeout of a stalled connection...
            }
            catch { return 0; }
        }
        return 0;
    }

    // ---- ConPTY wrapper ----
    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; public COORD(short x, short y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public int cb; public IntPtr lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle r, out SafeFileHandle w, IntPtr attrs, int size);
    [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(COORD size, SafeFileHandle hIn, SafeFileHandle hOut, uint flags, out IntPtr hPC);
    [DllImport("kernel32.dll")] static extern int ResizePseudoConsole(IntPtr hPC, COORD size);
    [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr hPC);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr cb, IntPtr prev, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint mode);
    [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint mode);
    [DllImport("kernel32.dll")] static extern bool SetConsoleCP(uint cp);
    [DllImport("kernel32.dll")] static extern bool SetConsoleOutputCP(uint cp);

    static void SizeOf(out short w, out short h)
    {
        try { w = (short)Console.WindowWidth; h = (short)Console.WindowHeight; } catch { w = 120; h = 30; }
        if (w < 2) w = 120; if (h < 2) h = 30;
    }

    static int Pty(string[] args)
    {
        if (args.Length == 0) return 1;
        IntPtr hIn = GetStdHandle(-10), hOut = GetStdHandle(-11);
        uint inMode = 0, outMode = 0;
        bool haveIn = GetConsoleMode(hIn, out inMode), haveOut = GetConsoleMode(hOut, out outMode);
        if (haveIn) SetConsoleMode(hIn, (inMode & ~0x7u) | 0x200u);          // raw input (no line editing, echo, Ctrl+C handling) + virtual-terminal sequences
        if (haveOut) SetConsoleMode(hOut, outMode | 0x5u);                    // virtual-terminal output processing
        SetConsoleCP(65001); SetConsoleOutputCP(65001);
        try
        {
            SafeFileHandle inRead, inWrite, outRead, outWrite;
            CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0); CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0);
            short w, h; SizeOf(out w, out h);
            IntPtr hPC;
            if (CreatePseudoConsole(new COORD(w, h), inRead, outWrite, 0, out hPC) != 0) { Console.Error.WriteLine("pet-helper: ConPTY is not available (Windows 10 1809+ is required)"); return 1; }
            var pipeName = "claude-pet-" + Process.GetCurrentProcess().Id;
            Environment.SetEnvironmentVariable("PET_PTY_SOCK", "\\\\.\\pipe\\" + pipeName);
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            var si = new STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            si.lpAttributeList = Marshal.AllocHGlobal(size);
            InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, ref size);
            UpdateProcThreadAttribute(si.lpAttributeList, 0, (IntPtr)0x20016, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero);
            var cmd = new StringBuilder("cmd.exe /c " + string.Join(" ", Array.ConvertAll(args, Quote)));
            PROCESS_INFORMATION pi;
            if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x80000u, IntPtr.Zero, null, ref si, out pi)) { Console.Error.WriteLine("pet-helper: cannot start the command (error " + Marshal.GetLastWin32Error() + ")"); return 1; }
            inRead.Dispose(); outWrite.Dispose(); // the pseudoconsole holds its own copies of these ends

            var toChild = new FileStream(inWrite, FileAccess.Write, 4096, false);
            var gate = new object();
            var outGate = new object(); // the child's output and the pet's title sequences must not interleave
            Action<byte[], int> write = (b, n) => { lock (gate) { try { toChild.Write(b, 0, n); toChild.Flush(); } catch { } } };
            // the terminal window -> the child
            new Thread(() => { var si2 = Console.OpenStandardInput(); var buf = new byte[4096]; int n; try { while ((n = si2.Read(buf, 0, buf.Length)) > 0) write(buf, n); } catch { } }) { IsBackground = true }.Start();
            // the child -> the terminal window
            new Thread(() => { var from = new FileStream(outRead, FileAccess.Read, 4096, false); var so = Console.OpenStandardOutput(); var buf = new byte[8192]; int n; try { while ((n = from.Read(buf, 0, buf.Length)) > 0) { lock (outGate) { so.Write(buf, 0, n); so.Flush(); } } } catch { } }) { IsBackground = true }.Start();
            // the pet -> the child (only this Windows user may connect)
            new Thread(() =>
            {
                var sec = new PipeSecurity();
                sec.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.ReadWrite, AccessControlType.Allow));
                while (true)
                {
                    try
                    {
                        using (var srv = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 4, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, sec))
                        {
                            srv.WaitForConnection();
                            var buf = new byte[4096]; int n;
                            while ((n = srv.Read(buf, 0, buf.Length)) > 0)
                            {
                                // "ESC ]ccpet-title;<text> BEL" from the pet: title this terminal window/tab (so the pet can raise it), not input for claude.
                                // Claude Code sets its own title too, so it is repeated for ~3 s.
                                string head = Encoding.UTF8.GetString(buf, 0, n);
                                if (head.StartsWith("\u001b]ccpet-title;") && head.IndexOf('\u0007') > 0)
                                {
                                    string title = Regex.Replace(head.Substring(14, head.IndexOf('\u0007') - 14), "[\\x00-\\x1f\\x7f]", "");
                                    var osc = new UTF8Encoding(false).GetBytes("\u001b]0;" + title + "\u0007");
                                    new Thread(() => { var so = Console.OpenStandardOutput(); for (int i = 0; i < 10; i++) { try { lock (outGate) { so.Write(osc, 0, osc.Length); so.Flush(); } } catch { } Thread.Sleep(300); } }) { IsBackground = true }.Start();
                                    continue;
                                }
                                write(buf, n);
                            }
                        }
                    }
                    catch { Thread.Sleep(200); }
                }
            }) { IsBackground = true }.Start();
            // follow the window size
            new Thread(() => { short lw = w, lh = h; while (true) { Thread.Sleep(400); short nw, nh; SizeOf(out nw, out nh); if (nw != lw || nh != lh) { lw = nw; lh = nh; ResizePseudoConsole(hPC, new COORD(nw, nh)); } } }) { IsBackground = true }.Start();

            WaitForSingleObject(pi.hProcess, 0xFFFFFFFFu);
            uint code; GetExitCodeProcess(pi.hProcess, out code);
            Thread.Sleep(150); // let the last output through
            ClosePseudoConsole(hPC);
            return (int)code;
        }
        finally
        {
            if (haveIn) SetConsoleMode(hIn, inMode);
            if (haveOut) SetConsoleMode(hOut, outMode);
        }
    }

    // ---- statusLine: Claude Code passes the account's rate limits on stdin; saved for the pet's limits ring ----
    static string Num(string json, string window, string field)
    {
        var w = Regex.Match(json, "\"rate_limits\"\\s*:\\s*\\{.*?\"" + window + "\"\\s*:\\s*\\{([^{}]*)\\}", RegexOptions.Singleline);
        if (!w.Success) return null;
        var f = Regex.Match(w.Groups[1].Value, "\"" + field + "\"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)");
        return f.Success ? f.Groups[1].Value : null;
    }

    static string Window(string json, string window, out double pct)
    {
        pct = 0;
        string p = Num(json, window, "used_percentage"), r = Num(json, window, "resets_at");
        if (p == null || r == null) return null;
        pct = double.Parse(p, System.Globalization.CultureInfo.InvariantCulture);
        return "{\"used_percentage\":" + p + ",\"resets_at\":" + r + "}";
    }

    static string JsonString(string json, string key)
    {
        var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        if (!m.Success) return null;
        var sb = new StringBuilder(); var v = m.Groups[1].Value;
        for (int i = 0; i < v.Length; i++)
        {
            char c = v[i];
            if (c != '\\' || i + 1 >= v.Length) { sb.Append(c); continue; }
            char n = v[++i];
            switch (n)
            {
                case 'n': sb.Append('\n'); break; case 't': sb.Append('\t'); break; case 'r': sb.Append('\r'); break;
                case 'b': sb.Append('\b'); break; case 'f': sb.Append('\f'); break;
                case 'u': if (i + 4 < v.Length) { sb.Append((char)Convert.ToInt32(v.Substring(i + 1, 4), 16)); i += 4; } break;
                default: sb.Append(n); break;
            }
        }
        return sb.ToString();
    }

    static void Out(string text) { var b = new UTF8Encoding(false).GetBytes(text); using (var o = Console.OpenStandardOutput()) { o.Write(b, 0, b.Length); o.Flush(); } }

    static int StatusLine(string[] args)
    {
        string input = "";
        try { using (var rd = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) input = rd.ReadToEnd(); } catch { }
        string chain = null;
        for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "--chain") chain = args[i + 1];
        try
        {
            double p5, p7;
            string five = Window(input, "five_hour", out p5), seven = Window(input, "seven_day", out p7);
            if (five != null || seven != null)
            {
                string file = Environment.GetEnvironmentVariable("CLAUDE_PET_USAGE");
                if (string.IsNullOrEmpty(file)) file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude-pet", "usage.json");
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                string tmp = file + "." + Process.GetCurrentProcess().Id + ".tmp";
                long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                File.WriteAllText(tmp, "{\"version\":1,\"updatedAt\":" + now + ",\"five_hour\":" + (five ?? "null") + ",\"seven_day\":" + (seven ?? "null") + "}", new UTF8Encoding(false));
                if (File.Exists(file)) File.Replace(tmp, file, null); else File.Move(tmp, file); // atomic: the pet never reads half a file
                if (chain == null)
                {
                    var parts = new System.Collections.Generic.List<string>();
                    if (five != null) parts.Add("5ч " + Math.Round(p5) + "%");
                    if (seven != null) parts.Add("нед " + Math.Round(p7) + "%");
                    Out(string.Join(" · ", parts) + "\n");
                }
            }
        }
        catch { /* a status line must never break the session */ }
        if (chain != null)
        {
            try
            {
                string b64 = chain.Replace('-', '+').Replace('_', '/'); while (b64.Length % 4 != 0) b64 += "=";
                string cmd = JsonString(Encoding.UTF8.GetString(Convert.FromBase64String(b64)), "command");
                if (!string.IsNullOrEmpty(cmd))
                {
                    // the user's own line: with Git Bash when there is one (that is what Claude Code uses on Windows), else cmd
                    string bash = Environment.GetEnvironmentVariable("CLAUDE_CODE_GIT_BASH_PATH");
                    if (string.IsNullOrEmpty(bash) || !File.Exists(bash)) bash = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "bin", "bash.exe");
                    var psi = File.Exists(bash) ? new ProcessStartInfo(bash, "-c " + Quote(cmd)) : new ProcessStartInfo("cmd.exe", "/d /s /c \"" + cmd + "\"");
                    psi.UseShellExecute = false; psi.RedirectStandardInput = true; psi.RedirectStandardOutput = true; psi.CreateNoWindow = true;
                    psi.StandardOutputEncoding = new UTF8Encoding(false);
                    using (var pr = Process.Start(psi))
                    {
                        var w = new StreamWriter(pr.StandardInput.BaseStream, new UTF8Encoding(false)); w.Write(input); w.Close();
                        var outTask = pr.StandardOutput.ReadToEndAsync();
                        if (pr.WaitForExit(4000) && outTask.Wait(500)) Out(outTask.Result);
                        else { try { pr.Kill(); } catch { } }
                    }
                }
            }
            catch { /* the user's own line failed: show nothing rather than break the session */ }
        }
        return 0;
    }

    static string Quote(string a) { return a.IndexOfAny(new[] { ' ', '\t', '"' }) >= 0 ? "\"" + a.Replace("\"", "\\\"") + "\"" : a; }

    static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "wait") return Wait(args[1]);
        if (args.Length >= 1 && args[0] == "statusline") { var rest = new string[args.Length - 1]; Array.Copy(args, 1, rest, 0, rest.Length); return StatusLine(rest); }
        if (args.Length >= 2 && args[0] == "oneshot") return IsOneShot(args[1]) ? 1 : 0; // self-test of the rule
        if (args.Length >= 2 && args[0] == "pty") { var rest = new string[args.Length - 1]; Array.Copy(args, 1, rest, 0, rest.Length); return Pty(rest); }
        return 0;
    }
}
