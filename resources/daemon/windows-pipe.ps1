param([Parameter(Mandatory=$true)][ValidatePattern('^trellis-daemon-v1-[a-f0-9]{64}$')][string]$Name)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
# The DACL and local-only flag are installed at creation, before any connection.
# This helper transports bounded opaque frames only; Electron owns authentication/dispatch.
Add-Type -ReferencedAssemblies System.dll,System.Core.dll,System.Web.Extensions.dll -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.ComponentModel;
using Microsoft.Win32.SafeHandles;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
public static class TrellisPrivatePipe {
  [StructLayout(LayoutKind.Sequential)]
  struct SecurityAttributes {
    public int Length;
    public IntPtr SecurityDescriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
  }
  [DllImport("kernel32.dll", EntryPoint="CreateNamedPipeW", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances,
    uint outBufferSize, uint inBufferSize, uint timeout, ref SecurityAttributes attributes);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientProcessId);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder name, ref uint size);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  sealed class ProcessLifetime : WaitHandle {
    public ProcessLifetime(IntPtr handle) { SafeWaitHandle = new SafeWaitHandle(handle, true); }
  }
  sealed class Peer : IDisposable {
    public readonly NamedPipeServerStream Pipe;
    public readonly ProcessLifetime Process;
    public readonly Dictionary<string,object> Owner;
    public RegisteredWaitHandle ExitWatch;
    readonly object queueLock=new object();
    readonly Queue<byte[]> outgoing=new Queue<byte[]>();
    int queuedBytes,queuedFrames;
    bool writing;
    int disposed;
    public Peer(NamedPipeServerStream pipe, uint pid, long connectedAt) {
      Pipe=pipe;
      IntPtr handle=OpenProcess(0x00101000u,false,pid); // SYNCHRONIZE + QUERY_LIMITED_INFORMATION
      if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      Process=new ProcessLifetime(handle);
      try {
        long creation,exit,kernel,user;
        if (!GetProcessTimes(handle,out creation,out exit,out kernel,out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
        long ticks=DateTime.FromFileTimeUtc(creation).Ticks;
        if (ticks > connectedAt) throw new InvalidOperationException();
        // This is only an extra temporal fence. Authority is established later
        // by the challenge proof for THIS retained live process identity. A PID
        // sampled after accept cannot prove which instance first opened a pipe.
        // Win32_Process CreationDate is DMTF microseconds. Keep the existing
        // original-owner identity representation, not a weaker PID-only cache.
        ticks=(ticks/10)*10;
        uint length=4096; StringBuilder executable=new StringBuilder((int)length);
        if (!QueryFullProcessImageName(handle,0,executable,ref length)) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr token;
        if (!OpenProcessToken(handle,0x0008u,out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        string sid;
        try { using (WindowsIdentity identity=new WindowsIdentity(token)) { sid=identity.User == null ? null : identity.User.Value; } }
        finally { CloseHandle(token); }
        using (WindowsIdentity current=WindowsIdentity.GetCurrent()) {
          if (sid == null || current.User == null || sid != current.User.Value || Process.WaitOne(0)) throw new InvalidOperationException();
        }
        Owner=new Dictionary<string,object> { {"pid",(int)pid}, {"startedAt",ticks.ToString(System.Globalization.CultureInfo.InvariantCulture)}, {"userId",sid}, {"executable",executable.ToString()} };
      } catch { Process.Dispose(); throw; }
    }
    public bool Alive() { try { return Interlocked.CompareExchange(ref disposed,0,0)==0 && !Process.WaitOne(0); } catch (ObjectDisposedException) { return false; } }
    public bool Enqueue(byte[] frame) {
      lock(queueLock) {
        if (!Alive() || queuedFrames >= 32 || queuedBytes+frame.Length > 1048576) return false;
        if (Interlocked.Add(ref TotalQueuedBytes,frame.Length) > 4194304) { Interlocked.Add(ref TotalQueuedBytes,-frame.Length); return false; }
        outgoing.Enqueue(frame); queuedBytes+=frame.Length; queuedFrames++;
        if (!writing) { writing=true; Task.Run(() => WritePending()); }
        return true;
      }
    }
    void WritePending() {
      while (true) {
        byte[] frame;
        lock(queueLock) {
          if (disposed != 0 || outgoing.Count == 0) { writing=false; return; }
          frame=outgoing.Dequeue();
        }
        bool failed=false;
        try { if (!Alive() || !Pipe.WriteAsync(frame,0,frame.Length).Wait(5000)) failed=true; }
        catch { failed=true; }
        finally {
          lock(queueLock) { queuedBytes-=frame.Length; queuedFrames--; Interlocked.Add(ref TotalQueuedBytes,-frame.Length); }
        }
        if (failed) { Dispose(); return; }
      }
    }
    public void Dispose() {
      if (Interlocked.Exchange(ref disposed,1)!=0) return;
      if (ExitWatch != null) ExitWatch.Unregister(null);
      Pipe.Dispose(); Process.Dispose();
      lock(queueLock) {
        while (outgoing.Count > 0) { byte[] frame=outgoing.Dequeue(); queuedBytes-=frame.Length; queuedFrames--; Interlocked.Add(ref TotalQueuedBytes,-frame.Length); }
      }
    }
  }
  const int MaxFrame = 262144;
  static readonly ConcurrentDictionary<int, Peer> Clients = new ConcurrentDictionary<int, Peer>();
  static readonly SemaphoreSlim Slots = new SemaphoreSlim(16, 16);
  static readonly object OutputLock = new object();
  static volatile bool Closing;
  static int NextId;
  static int TotalQueuedBytes;
  static NamedPipeServerStream Waiting;
  static void Emit(string text) { lock(OutputLock) { Console.Out.WriteLine(text); Console.Out.Flush(); } }
  static bool ReadAll(Stream stream, byte[] bytes) {
    int offset = 0;
    while (offset < bytes.Length) { int count = stream.Read(bytes, offset, bytes.Length-offset); if (count == 0) return false; offset += count; }
    return true;
  }
  static void ReadClient(int id, Peer peer) {
    NamedPipeServerStream pipe=peer.Pipe;
    try {
      while (!Closing) {
        byte[] header = new byte[4];
        if (!ReadAll(pipe, header)) break;
        int size = System.Net.IPAddress.NetworkToHostOrder(BitConverter.ToInt32(header,0));
        if (size < 1 || size > MaxFrame) break;
        byte[] data = new byte[size]; if (!ReadAll(pipe,data) || !peer.Alive()) break;
        Emit("{\"type\":\"frame\",\"id\":"+id+",\"data\":\""+Convert.ToBase64String(data)+"\"}");
      }
    } catch { } finally {
      Peer removed; Clients.TryRemove(id,out removed);
      peer.Dispose(); Slots.Release(); Emit("{\"type\":\"closed\",\"id\":"+id+"}");
    }
  }
  static NamedPipeServerStream Create(string name, bool first) {
    SecurityIdentifier sid;
    using (WindowsIdentity current=WindowsIdentity.GetCurrent()) { sid=current.User; }
    if (sid == null) throw new InvalidOperationException();
    PipeSecurity security = new PipeSecurity(); security.SetOwner(sid); security.SetAccessRuleProtection(true,false);
    security.AddAccessRule(new PipeAccessRule(sid,PipeAccessRights.FullControl,AccessControlType.Allow));
    byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
    IntPtr memory = Marshal.AllocHGlobal(descriptor.Length);
    try {
      Marshal.Copy(descriptor,0,memory,descriptor.Length);
      SecurityAttributes attributes = new SecurityAttributes {
        Length=Marshal.SizeOf(typeof(SecurityAttributes)), SecurityDescriptor=memory, InheritHandle=false
      };
      // Duplex + overlapped I/O; the first instance fails if this pipe name is already owned.
      // PIPE_REJECT_REMOTE_CLIENTS prevents a network logon from claiming a local PID.
      uint openMode=0x00000003u | 0x40000000u | (first ? 0x00080000u : 0u);
      SafePipeHandle handle=CreateNamedPipe(@"\\.\pipe\"+name,openMode,0x00000008u,16,4096,4096,0,ref attributes);
      if (handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
      try { return new NamedPipeServerStream(PipeDirection.InOut,true,false,handle); }
      catch { handle.Dispose(); throw; }
    } finally { Marshal.FreeHGlobal(memory); }
  }
  static void Accept(string name) {
    try {
      bool ready = false;
      while (!Closing) {
        Slots.Wait();
        NamedPipeServerStream pipe = Create(name,!ready); Waiting = pipe;
        if (!ready) { Emit("{\"type\":\"ready\"}"); ready=true; }
        pipe.WaitForConnection(); long connectedAt=DateTime.UtcNow.Ticks; Waiting = null;
        if (Closing) { pipe.Dispose(); break; }
        uint clientPid;
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out clientPid) || clientPid == 0) { pipe.Dispose(); Slots.Release(); continue; }
        Peer peer;
        try { peer=new Peer(pipe,clientPid,connectedAt); }
        catch { pipe.Dispose(); Slots.Release(); continue; }
        int id = Interlocked.Increment(ref NextId); Clients[id]=peer;
        peer.ExitWatch=ThreadPool.RegisterWaitForSingleObject(peer.Process, (state,timedOut) => { try { peer.Pipe.Dispose(); } catch { } }, null, Timeout.Infinite, true);
        string owner=new JavaScriptSerializer().Serialize(peer.Owner);
        Emit("{\"type\":\"connected\",\"id\":"+id+",\"clientPid\":"+clientPid+",\"owner\":"+owner+"}");
        Task.Run(() => ReadClient(id,peer));
      }
    } catch { if (!Closing) Emit("{\"type\":\"fatal\"}"); }
  }
  public static void Run(string name) {
    Task.Run(() => Accept(name));
    try {
      string line; JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength=400000;
      while ((line=Console.ReadLine()) != null) {
        if (line.Length > 400000) break;
        Dictionary<string,object> message=json.Deserialize<Dictionary<string,object>>(line);
        int id=Convert.ToInt32(message["id"]); Peer peer;
        if (!Clients.TryGetValue(id,out peer)) continue;
        if (message.ContainsKey("close") || !peer.Alive()) { peer.Dispose(); continue; }
        byte[] data=Convert.FromBase64String((string)message["data"]);
        if (data.Length < 1 || data.Length > MaxFrame) break;
        byte[] frame=new byte[data.Length+4];
        Buffer.BlockCopy(BitConverter.GetBytes(System.Net.IPAddress.HostToNetworkOrder(data.Length)),0,frame,0,4);
        Buffer.BlockCopy(data,0,frame,4,data.Length);
        // Each peer has one progressing writer. A slow reader consumes only its
        // own bounded queue and timeout, never the helper's global input loop.
        if (!peer.Enqueue(frame)) peer.Dispose();
      }
    } catch { Emit("{\"type\":\"fatal\"}"); } finally {
      Closing=true; if (Waiting != null) Waiting.Dispose(); foreach (var peer in Clients.Values) peer.Dispose();
    }
  }
}
'@
[TrellisPrivatePipe]::Run($Name)
