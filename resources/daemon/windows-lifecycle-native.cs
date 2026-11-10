using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// Loaded only by the fixed native lifecycle scripts. No PID-only termination API.
public static class CruxLifecycleNative {
  // Console.In is a synchronized reader on .NET Framework; its own ReadLineAsync
  // may block the calling thread. Keep input off the watchdog thread.
  public static Task<string> ReadControlLine() { return Task.Run(() => Console.In.ReadLine()); }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public uint cb; public IntPtr reserved,desktop,title; public uint x,y,width,height,xchars,ychars,fill,flags; public ushort show,reserved2; public IntPtr reservedBytes,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long processTime,jobTime; public uint flags; public UIntPtr minWorkingSet,maxWorkingSet; public uint activeProcessLimit; public UIntPtr affinity; public uint priorityClass,schedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOperations,writeOperations,otherOperations,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long userTime,kernelTime,periodUserTime,periodKernelTime; public uint faults,totalProcesses,activeProcesses,terminatedProcesses; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct PROCESSENTRY32 { public uint size,usage,pid; public UIntPtr heap; public uint module,threads,parent; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string exe; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFOEX startup,out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT limits,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out ACCOUNTING accounting,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder name,ref uint size);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref PROCESSENTRY32 entry);
  [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command,out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr file,StringBuilder path,uint size,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module,string name);
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int QueryProcess(IntPtr process,int kind,IntPtr value,uint size,out uint returned);
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int QuerySystem(int kind,IntPtr value,uint size,out uint returned);
  public static string BootStartedAt() {
    IntPtr address=GetProcAddress(GetModuleHandleW("ntdll.dll"),"NtQuerySystemInformation");
    if(address==IntPtr.Zero) throw new InvalidOperationException("boot-unavailable");
    var query=(QuerySystem)Marshal.GetDelegateForFunctionPointer(address,typeof(QuerySystem));
    IntPtr buffer=Marshal.AllocHGlobal(48);
    try {
      uint returned;
      // SystemTimeOfDayInformation: kernel boot/current FILETIMEs, not an
      // application timestamp or an estimate from wall-clock time and uptime.
      if(query(3,buffer,48,out returned)<0 || returned<16) throw new InvalidOperationException("boot-unavailable");
      long boot=Marshal.ReadInt64(buffer),now=Marshal.ReadInt64(buffer,8);
      if(boot<=0 || now<=boot) throw new InvalidOperationException("boot-unavailable");
      return DateTime.FromFileTimeUtc(boot).Ticks.ToString();
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  static Exception Failure(string operation) { return new Win32Exception(Marshal.GetLastWin32Error(),operation); }
  public sealed class Owner {
    public int pid; public string startedAt,userId,executable;
  }
  public sealed class CapturedProcess : IDisposable {
    internal IntPtr handle; public Owner owner;
    internal CapturedProcess(IntPtr value,Owner identity) { handle=value; owner=identity; }
    public bool Exited { get { uint state=WaitForSingleObject(handle,0); if(state==0) return true; if(state==258) return false; throw Failure("process-wait"); } }
    public void Terminate() { if(!Exited && !TerminateProcess(handle,71)) throw Failure("process-terminate"); }
    public void Dispose() { if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
  }
  public sealed class CapturedJob : IDisposable {
    internal IntPtr handle;
    internal CapturedJob(IntPtr value) { handle=value; }
    public bool Empty { get { ACCOUNTING value; if(!QueryInformationJobObject(handle,1,out value,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero)) throw Failure("job-query"); return value.activeProcesses==0; } }
    public bool Contains(CapturedProcess process) { bool member; if(!IsProcessInJob(process.handle,handle,out member)) throw Failure("job-membership"); return member; }
    public void Terminate() { if(!Empty && !TerminateJobObject(handle,71)) throw Failure("job-terminate"); }
    public void Dispose() { if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
  }
  static Owner Identity(IntPtr handle,int pid) {
    long created,exited,kernel,user;
    if(!GetProcessTimes(handle,out created,out exited,out kernel,out user)) throw Failure("process-birth");
    uint length=32768; var image=new StringBuilder((int)length);
    if(!QueryFullProcessImageNameW(handle,0,image,ref length)) throw Failure("process-image");
    IntPtr token;
    if(!OpenProcessToken(handle,8,out token)) throw Failure("process-user");
    try {
      using(var identity=new WindowsIdentity(token)) {
        return new Owner { pid=pid,startedAt=DateTime.FromFileTimeUtc(created).Ticks.ToString(),userId=identity.User.Value,executable=Path.GetFullPath(image.ToString()) };
      }
    } finally { CloseHandle(token); }
  }
  public static bool Same(Owner a,Owner b) {
    // CIM historically persists microseconds; retain exact kernel handles after comparison.
    return a.pid==b.pid && Int64.Parse(a.startedAt)/10==Int64.Parse(b.startedAt)/10
      && a.userId==b.userId && (String.Equals(a.executable,b.executable,StringComparison.OrdinalIgnoreCase)
        || String.Equals(CanonicalPath(a.executable),CanonicalPath(b.executable),StringComparison.OrdinalIgnoreCase));
  }
  public static string CanonicalPath(string path) {
    IntPtr file=CreateFileW(path,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
    if(file==new IntPtr(-1)) throw Failure("canonical-path");
    try {
      var value=new StringBuilder(32768); uint length=GetFinalPathNameByHandleW(file,value,32768,0);
      if(length==0 || length>=32768) throw Failure("canonical-path");
      string result=value.ToString();
      if(result.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase)) return @"\\"+result.Substring(8);
      return result.StartsWith(@"\\?\",StringComparison.Ordinal)?result.Substring(4):result;
    } finally { CloseHandle(file); }
  }
  public static bool SameBirth(string a,string b) { return Int64.Parse(a)/10==Int64.Parse(b)/10; }
  public static CapturedProcess Capture(Owner expected) { return CaptureOriginal(expected,false); }
  public static CapturedProcess CaptureOriginal(Owner expected,bool recovering) {
    if(expected.pid<=0 || expected.userId!=WindowsIdentity.GetCurrent().User.Value) throw new InvalidOperationException("foreign-owner");
    IntPtr handle=OpenProcess(0x101001,false,expected.pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION | TERMINATE
    if(handle==IntPtr.Zero) {
      int error=Marshal.GetLastWin32Error();
      if(error==87 || error==1168) return null;
      throw Failure("process-open");
    }
    try {
      if(recovering) {
        long created,ended,kernel,user;
        if(!GetProcessTimes(handle,out created,out ended,out kernel,out user)) throw Failure("process-birth");
        // A durable original scope may outlive a PID. A different kernel birth
        // proves that original exited; never retain or terminate the replacement.
        if(!SameBirth(DateTime.FromFileTimeUtc(created).Ticks.ToString(),expected.startedAt)) return null;
      }
      // Exited processes can retain their kernel object while image/token queries
      // are no longer available. Birth plus the retained signaled handle proves
      // original exit; never reopen by PID to perform a termination.
      if(WaitForSingleObject(handle,0)==0) {
        long created,ended,kernel,user;
        if(!GetProcessTimes(handle,out created,out ended,out kernel,out user)) throw Failure("process-birth");
        if(!SameBirth(DateTime.FromFileTimeUtc(created).Ticks.ToString(),expected.startedAt)) throw new InvalidOperationException("identity-changed");
        var exited=new CapturedProcess(handle,expected); handle=IntPtr.Zero; return exited;
      }
      Owner actual=Identity(handle,expected.pid);
      if(!Same(expected,actual)) throw new InvalidOperationException("identity-changed");
      var result=new CapturedProcess(handle,actual); handle=IntPtr.Zero; return result;
    } finally { if(handle!=IntPtr.Zero) CloseHandle(handle); }
  }
  public static Owner Inspect(int pid) {
    IntPtr handle=OpenProcess(0x101000,false,pid);
    if(handle==IntPtr.Zero) {
      int error=Marshal.GetLastWin32Error(); if(error==87 || error==1168) return null;
      throw Failure("process-open");
    }
    try { return WaitForSingleObject(handle,0)==0?null:Identity(handle,pid); } finally { CloseHandle(handle); }
  }
  public static CapturedJob OpenJob(string name) {
    IntPtr job=OpenJobObjectW(12,false,name);
    if(job==IntPtr.Zero) { if(Marshal.GetLastWin32Error()==2) return null; throw Failure("job-open"); }
    return new CapturedJob(job);
  }
  public static string[] Argv(string command) {
    int count; IntPtr values=CommandLineToArgvW(command,out count);
    if(values==IntPtr.Zero) throw Failure("argv");
    try { var result=new string[count]; for(int i=0;i<count;i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(values,i*IntPtr.Size)); return result; }
    finally { LocalFree(values); }
  }
  public static string[] Arguments(CapturedProcess original) {
    if(original==null || original.Exited) throw new InvalidOperationException("command-unavailable");
    // Win10+ native command-line query uses the already-verified process handle.
    // Resolve dynamically and fail closed if this information class is unavailable;
    // do not depend on the asynchronous WMI provider for lifecycle deadlines.
    IntPtr address=GetProcAddress(GetModuleHandleW("ntdll.dll"),"NtQueryInformationProcess");
    if(address==IntPtr.Zero) throw new InvalidOperationException("command-unavailable");
    var query=(QueryProcess)Marshal.GetDelegateForFunctionPointer(address,typeof(QueryProcess));
    uint needed; query(original.handle,60,IntPtr.Zero,0,out needed);
    for(int attempt=0;attempt<2;attempt++) {
      if(needed<16 || needed>131072) throw new InvalidOperationException("command-unavailable");
      uint capacity=needed; IntPtr buffer=Marshal.AllocHGlobal((int)capacity);
      try {
        int status=query(original.handle,60,buffer,capacity,out needed);
        if(status<0) { if(needed>capacity) continue; throw new InvalidOperationException("command-unavailable"); }
        int bytes=(ushort)Marshal.ReadInt16(buffer);
        IntPtr text=Marshal.ReadIntPtr(buffer,IntPtr.Size==8?8:4);
        long start=buffer.ToInt64(),pointer=text.ToInt64();
        if(bytes==0 || bytes>65534 || bytes%2!=0 || pointer<start || pointer+bytes>start+capacity || original.Exited) throw new InvalidOperationException("command-unavailable");
        return Argv(Marshal.PtrToStringUni(text,bytes/2));
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    throw new InvalidOperationException("command-unavailable");
  }
  public static Owner[] FindInstallationProcesses(string executable) {
    string canonical=CanonicalPath(executable);
    string user=WindowsIdentity.GetCurrent().User.Value;
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1)) throw Failure("installation-processes");
    try {
      var found=new List<Owner>(); var images=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      PROCESSENTRY32 entry=new PROCESSENTRY32(); entry.size=(uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if(!Process32FirstW(snapshot,ref entry)) throw Failure("installation-processes");
      int count=0;
      do {
        if(++count>16384) throw new InvalidOperationException("process-inventory-limit");
        if(entry.pid==0) continue;
        // Native full image comparison, never process-name matching. WMI's image
        // string may retain a short/junction alias used at launch.
        IntPtr process=OpenProcess(0x101000,false,(int)entry.pid);
        if(process==IntPtr.Zero) continue;
        try {
          if(WaitForSingleObject(process,0)==0) continue;
          uint size=32768; var image=new StringBuilder((int)size);
          if(!QueryFullProcessImageNameW(process,0,image,ref size)) continue;
          string imagePath=image.ToString(),physical;
          if(!images.TryGetValue(imagePath,out physical)) {
            try { physical=CanonicalPath(imagePath); } catch(Win32Exception) { continue; }
            images.Add(imagePath,physical);
          }
          if(!String.Equals(physical,canonical,StringComparison.OrdinalIgnoreCase)) continue;
          // Permission/identity failure for this exact installation is an error,
          // not evidence that its GUI is absent. Unrelated tokens are not opened.
          Owner owner=Identity(process,(int)entry.pid);
          if(owner.userId==user) found.Add(owner);
        } finally { CloseHandle(process); }
      } while(Process32NextW(snapshot,ref entry));
      return found.ToArray();
    } finally { CloseHandle(snapshot); }
  }
  public static int[] Children(CapturedProcess parent) {
    // Enumeration only establishes coverage of the already-held original process.
    // It never authorizes terminating a discovered PID.
    if(parent==null) return new int[0];
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1)) throw Failure("child-coverage");
    try {
      var found=new List<int>(); PROCESSENTRY32 entry=new PROCESSENTRY32(); entry.size=(uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if(!Process32FirstW(snapshot,ref entry)) throw Failure("child-coverage");
      do { if(entry.parent==(uint)parent.owner.pid) found.Add((int)entry.pid); } while(Process32NextW(snapshot,ref entry));
      return found.ToArray();
    } finally { CloseHandle(snapshot); }
  }
  public static string Quote(string value) {
    if(value==null || value.IndexOf('\0')>=0) throw new ArgumentException("argument");
    var result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) { if(c=='\\') { slashes++; continue; } result.Append('\\',c=='"'?slashes*2+1:slashes); result.Append(c); slashes=0; }
    return result.Append('\\',slashes*2).Append('"').ToString();
  }
  static PROCESS_INFORMATION Create(string executable,string[] args,IntPtr job) {
    var line=new StringBuilder(Quote(executable)); foreach(string arg in args) line.Append(' ').Append(Quote(arg));
    if(line.Length>=32767) throw new ArgumentException("arguments");
    STARTUPINFOEX startup=new STARTUPINFOEX(); startup.startup.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.startup.flags=1;
    IntPtr size=IntPtr.Zero,value=IntPtr.Zero; bool initialized=false;
    try {
      uint flags=0x08000200; // NO_WINDOW | NEW_PROCESS_GROUP, never inherit control handles.
      if(job!=IntPtr.Zero) {
        InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size); startup.attributes=Marshal.AllocHGlobal(size);
        if(!InitializeProcThreadAttributeList(startup.attributes,1,0,ref size)) throw Failure("attributes"); initialized=true;
        value=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(value,job);
        if(!UpdateProcThreadAttribute(startup.attributes,0,new IntPtr(0x2000d),value,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw Failure("atomic-job");
        flags|=0x80004; // Job assignment is atomic with creation; root remains suspended until witness publication.
      } else startup.startup.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFO));
      PROCESS_INFORMATION info;
      if(!CreateProcessW(executable,line,IntPtr.Zero,IntPtr.Zero,false,flags,IntPtr.Zero,Path.GetDirectoryName(executable),ref startup,out info)) throw Failure("create");
      return info;
    } finally { if(initialized) DeleteProcThreadAttributeList(startup.attributes); if(startup.attributes!=IntPtr.Zero) Marshal.FreeHGlobal(startup.attributes); if(value!=IntPtr.Zero) Marshal.FreeHGlobal(value); }
  }
  public static Owner Detach(string executable,string[] args) {
    PROCESS_INFORMATION info=Create(executable,args,IntPtr.Zero);
    try { return Identity(info.process,(int)info.pid); } finally { CloseHandle(info.thread); CloseHandle(info.process); }
  }
  public sealed class Guardian : IDisposable {
    public CapturedJob job; public CapturedProcess root; IntPtr thread;
    public Guardian(string name,string executable,string[] args) {
      IntPtr handle=CreateJobObjectW(IntPtr.Zero,name); int error=Marshal.GetLastWin32Error();
      if(handle==IntPtr.Zero) throw Failure("job-create");
      if(error==183) { CloseHandle(handle); throw new InvalidOperationException("job-exists"); }
      job=new CapturedJob(handle);
      try {
        // The independent guardian owns crash containment. Neither breakaway
        // flag is set; loss of its final Job handle cannot orphan descendants.
        EXTENDED_LIMIT limits=new EXTENDED_LIMIT(); limits.basic.flags=0x2000;
        if(!SetInformationJobObject(handle,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) throw Failure("job-limits");
        PROCESS_INFORMATION info=Create(executable,args,handle); thread=info.thread;
        root=new CapturedProcess(info.process,Identity(info.process,(int)info.pid));
      } catch { Dispose(); throw; }
    }
    public void Resume() { if(ResumeThread(thread)==0xffffffff) throw Failure("resume"); CloseHandle(thread); thread=IntPtr.Zero; }
    public void Dispose() {
      if(job!=null) { try { job.Terminate(); } finally { job.Dispose(); } job=null; }
      if(thread!=IntPtr.Zero) { CloseHandle(thread); thread=IntPtr.Zero; }
      if(root!=null) { root.Dispose(); root=null; }
    }
  }
}
