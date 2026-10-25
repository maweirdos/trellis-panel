param([string]$ExecutableBase64, [string]$ArgumentsBase64)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  $executable = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ExecutableBase64))
  $arguments = [string[]]([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64)) | ConvertFrom-Json)
  if (-not [IO.Path]::IsPathRooted($executable) -or -not [IO.File]::Exists($executable) -or $arguments.Count -lt 2 -or $arguments.Count -gt 3) { throw 'Invalid native launch' }
  if ($arguments[-2] -cne '--trellis-role=daemon' -or $arguments[-1] -cnotmatch '^--trellis-user-data-base64=[A-Za-z0-9+/=]+$') { throw 'Invalid daemon arguments' }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class TrellisDetachedLaunch {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Startup {
    public int cb; public string reserved, desktop, title;
    public int x,y,width,height,xchars,ychars,fill,flags;
    public short show, reservedBytes; public IntPtr reservedPointer,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
      result.Append(c); slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }
  public static uint Start(string executable, string[] arguments) {
    var command = new StringBuilder(Quote(executable));
    foreach (string argument in arguments) {
      if (argument == null || argument.IndexOf('\0') >= 0) throw new ArgumentException();
      command.Append(' ').Append(Quote(argument));
    }
    if (command.Length >= 32767) throw new ArgumentException();
    var startup = new Startup(); startup.cb = Marshal.SizeOf(typeof(Startup)); startup.flags = 1; startup.show = 0;
    ProcessInfo info;
    // No inherited handles, no parent console, no shell or command evaluation.
    if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false, 0x208u, IntPtr.Zero,
      System.IO.Path.GetDirectoryName(executable), ref startup, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { return info.pid; } finally { CloseHandle(info.thread); CloseHandle(info.process); }
  }
}
'@
  $launchedPid = [TrellisDetachedLaunch]::Start($executable, [string[]]$arguments)
  @{pid=[int]$launchedPid} | ConvertTo-Json -Compress
} catch {
  @{state='unavailable'; exception=$_.Exception.GetType().Name; hresult=$_.Exception.HResult; line=$_.InvocationInfo.ScriptLineNumber} | ConvertTo-Json -Compress
  exit 1
}
