// pet-helper.exe: small native helper of Claude Pet (no runtime to install: compiled with the .NET Framework that ships with Windows).
//   pet-helper.exe wait <mailboxUrl>   the mailbox waiter: an `asyncRewake` hook of Claude Code.
//     Reads the hook JSON from stdin (session_id), long-polls <mailboxUrl>/<session_id>. A message (HTTP 200) is written to stderr and the
//     process exits with code 2: Claude Code then wakes the session with that text. Everything else (no pet, 409 = another waiter,
//     the claude process is gone) exits 0 quietly.
using System;
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

    static int Wait(string baseUrl)
    {
        string json;
        try { json = Console.In.ReadToEnd(); } catch { return 0; }
        var m = Regex.Match(json, "\"session_id\"\\s*:\\s*\"([A-Za-z0-9_-]{1,100})\"");
        if (!m.Success || !baseUrl.StartsWith("http://127.0.0.1:")) return 0;
        var url = baseUrl.TrimEnd('/') + "/" + m.Groups[1].Value;
        int parent = ParentPid();
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

    static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "wait") return Wait(args[1]);
        return 0;
    }
}
