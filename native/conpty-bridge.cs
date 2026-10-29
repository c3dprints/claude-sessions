// conpty-bridge: runs one command inside a Windows pseudo console (ConPTY) and
// relays it over this process's standard streams, so Node can host a real
// terminal without a native Node module.
//
//   conpty-bridge.exe <cols> <rows> <workdir> <command line>
//
// stdout  raw terminal output (VT sequences, UTF-8), exactly as ConPTY emits it
// stdin   frames: [type:1][length:4, little endian][payload]
//           0 = input bytes, 1 = resize (cols:int16, rows:int16), 2 = close
// stderr  "PID <n>" once the command has started, "ERR <text>" on failure
// exit    the command's exit code (90+ for bridge failures)
//
// Compiled on first use with the .NET Framework csc.exe that ships with Windows,
// so the source stays C# 5.

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class Bridge
{
    [StructLayout(LayoutKind.Sequential)]
    struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern int CreatePseudoConsole(COORD size, SafeFileHandle hInput, SafeFileHandle hOutput, uint flags, out IntPtr phPC);
    [DllImport("kernel32.dll")]
    static extern int ResizePseudoConsole(IntPtr hPC, COORD size);
    [DllImport("kernel32.dll")]
    static extern void ClosePseudoConsole(IntPtr hPC);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out SafeFileHandle hRead, out SafeFileHandle hWrite, IntPtr sa, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateProcessW")]
    static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")]
    static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr h, uint ms);

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const int STARTF_USESTDHANDLES = 0x00000100;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;

    static bool ReadFull(Stream s, byte[] buf, int len)
    {
        int got = 0;
        while (got < len)
        {
            int n = s.Read(buf, got, len - got);
            if (n <= 0) return false;
            got += n;
        }
        return true;
    }

    static int Fail(string msg, int code)
    {
        Console.Error.WriteLine("ERR " + msg);
        Console.Error.Flush();
        return code;
    }

    static int Main(string[] args)
    {
        if (args.Length != 4) return Fail("usage: conpty-bridge <cols> <rows> <workdir> <command line>", 91);
        COORD size = new COORD { X = short.Parse(args[0]), Y = short.Parse(args[1]) };

        SafeFileHandle inRead, inWrite, outRead, outWrite;
        if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0) || !CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0))
            return Fail("CreatePipe " + Marshal.GetLastWin32Error(), 92);

        IntPtr hPC;
        int hr = CreatePseudoConsole(size, inRead, outWrite, 0, out hPC);
        if (hr != 0) return Fail("CreatePseudoConsole 0x" + hr.ToString("x"), 93);

        IntPtr attrSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
        STARTUPINFOEX si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        // Our own std handles are pipes to Node; without this the child would
        // inherit them instead of talking to the pseudo console.
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.lpAttributeList = Marshal.AllocHGlobal(attrSize);
        if (!InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, ref attrSize))
            return Fail("InitializeProcThreadAttributeList " + Marshal.GetLastWin32Error(), 94);
        if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            return Fail("UpdateProcThreadAttribute " + Marshal.GetLastWin32Error(), 95);

        PROCESS_INFORMATION pi;
        if (!CreateProcess(null, new StringBuilder(args[3]), IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, args[2], ref si, out pi))
            return Fail("CreateProcess " + Marshal.GetLastWin32Error() + " for " + args[3], 96);

        // The pseudo console holds its own copies; ours must go so reads end when it closes.
        inRead.Dispose();
        outWrite.Dispose();
        Console.Error.WriteLine("PID " + pi.dwProcessId);
        Console.Error.Flush();

        Stream stdout = Console.OpenStandardOutput();
        FileStream ptyOut = new FileStream(outRead, FileAccess.Read, 4096, false);
        Thread reader = new Thread(delegate ()
        {
            byte[] buf = new byte[16384];
            try
            {
                int n;
                while ((n = ptyOut.Read(buf, 0, buf.Length)) > 0)
                {
                    stdout.Write(buf, 0, n);
                    stdout.Flush();
                }
            }
            catch (Exception) { /* pseudo console closed or Node went away */ }
        });
        reader.IsBackground = true;
        reader.Start();

        ManualResetEvent closeRequested = new ManualResetEvent(false);
        FileStream ptyIn = new FileStream(inWrite, FileAccess.Write, 4096, false);
        Thread writer = new Thread(delegate ()
        {
            Stream stdin = Console.OpenStandardInput();
            byte[] head = new byte[5];
            try
            {
                while (ReadFull(stdin, head, 5))
                {
                    int len = BitConverter.ToInt32(head, 1);
                    if (len < 0 || len > (1 << 20)) break;
                    byte[] payload = new byte[len];
                    if (!ReadFull(stdin, payload, len)) break;
                    if (head[0] == 0) { ptyIn.Write(payload, 0, len); ptyIn.Flush(); }
                    else if (head[0] == 1 && len == 4)
                    {
                        COORD c = new COORD { X = BitConverter.ToInt16(payload, 0), Y = BitConverter.ToInt16(payload, 2) };
                        if (c.X > 0 && c.Y > 0) ResizePseudoConsole(hPC, c);
                    }
                    else if (head[0] == 2) break;
                }
            }
            catch (Exception) { /* stdin closed */ }
            // A closed stdin means Node is gone, which also ends the session.
            closeRequested.Set();
        });
        writer.IsBackground = true;
        writer.Start();

        ManualResetEvent exited = new ManualResetEvent(false);
        exited.SafeWaitHandle = new SafeWaitHandle(pi.hProcess, false);
        WaitHandle.WaitAny(new WaitHandle[] { exited, closeRequested });

        // ClosePseudoConsole asks attached programs to close (CTRL_CLOSE_EVENT) and can
        // block until the output pipe is drained, so it runs while the reader keeps reading.
        Thread closer = new Thread(delegate () { ClosePseudoConsole(hPC); });
        closer.IsBackground = true;
        closer.Start();
        if (WaitForSingleObject(pi.hProcess, 5000) != 0) TerminateProcess(pi.hProcess, 1);
        closer.Join(3000);
        reader.Join(2000);

        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        return (int)code;
    }
}
