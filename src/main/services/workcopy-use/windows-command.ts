/** Fixed native launcher. Command arguments stay in a protected JSON file. */
export const WINDOWS_WORKCOPY_COMMAND = String.raw`param([ValidateSet('run','transport','cleanup')][string]$Mode,[string]$SpecPath)
$ErrorActionPreference='Stop'
$originalPSModulePath=$env:PSModulePath
$env:PSModulePath=Join-Path $PSHOME 'Modules'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$spec=Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
$workcopySource=@'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TrellisWorkcopyCommand {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public uint cb; public IntPtr reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,reserved2; public IntPtr reservedBytes,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint processId,threadId; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long processTime,jobTime; public uint flags; public UIntPtr minWorkingSet,maxWorkingSet; public uint activeProcessLimit; public UIntPtr affinity; public uint priorityClass,schedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOperations,writeOperations,otherOperations,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long userTime,kernelTime,periodUserTime,periodKernelTime; public uint faults,totalProcesses,activeProcesses,terminatedProcesses; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct PROCESSENTRY32 { public uint size,usage,pid; public UIntPtr heap; public uint module,threads,parent; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string exe; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT limits,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out ACCOUNTING accounting,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string executable,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFOEX startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module,string name);
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int QueryProcess(IntPtr process,int kind,IntPtr value,uint size,out uint returned);
  public sealed class WrapperInfo { public int ProcessId; public long CreatedTicks; }
  static string ReadCommandLine(IntPtr handle) {
    IntPtr address=GetProcAddress(GetModuleHandleW("ntdll.dll"),"NtQueryInformationProcess");
    if(address==IntPtr.Zero) return null;
    var query=(QueryProcess)Marshal.GetDelegateForFunctionPointer(address,typeof(QueryProcess));
    uint needed; query(handle,60,IntPtr.Zero,0,out needed);
    for(int attempt=0;attempt<2;attempt++) {
      if(needed<16 || needed>131072) return null;
      uint capacity=needed; IntPtr buffer=Marshal.AllocHGlobal((int)capacity);
      try {
        int status=query(handle,60,buffer,capacity,out needed);
        if(status<0) { if(needed>capacity) continue; return null; }
        int bytes=(ushort)Marshal.ReadInt16(buffer);
        IntPtr text=Marshal.ReadIntPtr(buffer,IntPtr.Size==8?8:4);
        long start=buffer.ToInt64(),pointer=text.ToInt64();
        if(bytes==0 || bytes>65534 || bytes%2!=0 || pointer<start || pointer+bytes>start+capacity) return null;
        return Marshal.PtrToStringUni(text,bytes/2);
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    return null;
  }
  public static WrapperInfo[] FindWrappers(string specPath,int selfPid) {
    var list=new List<WrapperInfo>();
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1)) return null;
    try {
      PROCESSENTRY32 entry=new PROCESSENTRY32(); entry.size=(uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if(!Process32FirstW(snapshot,ref entry)) return null;
      do {
        int pid=(int)entry.pid;
        if(pid<=0 || pid==selfPid) continue;
        if(!String.Equals(entry.exe,"powershell.exe",StringComparison.OrdinalIgnoreCase)) continue;
        IntPtr h=OpenProcess(0x101000,false,pid);
        if(h==IntPtr.Zero) continue;
        try {
          if(WaitForSingleObject(h,0)==0) continue;
          string cmd=ReadCommandLine(h);
          if(String.IsNullOrEmpty(cmd) || !cmd.Contains(specPath)) continue;
          if(!cmd.Contains("-Mode run") && !cmd.Contains("-Mode transport")) continue;
          long created,exited,kernel,user;
          if(!GetProcessTimes(h,out created,out exited,out kernel,out user)) continue;
          list.Add(new WrapperInfo { ProcessId=pid, CreatedTicks=DateTime.FromFileTimeUtc(created).Ticks });
        } finally { CloseHandle(h); }
      } while(Process32NextW(snapshot,ref entry));
      return list.ToArray();
    } finally { CloseHandle(snapshot); }
  }
  static string Quote(string value) {
    if(value.IndexOf('\0')>=0) throw new Exception("Invalid argument");
    StringBuilder text=new StringBuilder("\""); int slashes=0;
    foreach(char ch in value) { if(ch=='\\') { slashes++; continue; } if(ch=='"') { text.Append('\\',slashes*2+1); text.Append('"'); } else { text.Append('\\',slashes); text.Append(ch); } slashes=0; }
    text.Append('\\',slashes*2); text.Append('"'); return text.ToString();
  }
  static bool Empty(IntPtr job) { ACCOUNTING state; if(!QueryInformationJobObject(job,1,out state,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero)) throw new Exception("Cannot query original process job"); return state.activeProcesses==0; }
  public static bool Clean(string name) {
    IntPtr job=OpenJobObjectW(12,false,name); // QUERY | TERMINATE; never assign foreign processes.
    if(job==IntPtr.Zero) { if(Marshal.GetLastWin32Error()==2) return true; throw new Exception("Cannot open original process job"); }
    try { if(!Empty(job) && !TerminateJobObject(job,71)) throw new Exception("Cannot stop original process job"); for(int i=0;i<100;i++) { if(Empty(job)) return true; Thread.Sleep(25); } return false; }
    finally { CloseHandle(job); }
  }
  public static void StopWitness(int pid,long startedAt) {
    IntPtr process=OpenProcess(0x1001,false,pid);
    if(process==IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); if(error==87||error==1168) return; throw new Exception("Cannot verify original helper"); }
    try { long created,exited,kernel,user; if(!GetProcessTimes(process,out created,out exited,out kernel,out user)) throw new Exception("Cannot read original helper birth");
      if(DateTime.FromFileTimeUtc(created).Ticks/10!=startedAt/10) return;
      uint code; if(GetExitCodeProcess(process,out code)&&code!=259) return;
      if(!TerminateProcess(process,71)) throw new Exception("Cannot stop original helper");
      if(WaitForSingleObject(process,2500)!=0) throw new Exception("Original helper has not exited");
    } finally { CloseHandle(process); }
  }
  public static void Save(string path,string value) { using(FileStream file=new FileStream(path,FileMode.Create,FileAccess.Write,FileShare.Read)) { byte[] bytes=Encoding.UTF8.GetBytes(value); file.Write(bytes,0,bytes.Length); file.Flush(true); } }
  public static void Run(string executable,string[] args,string cwd,string name,string result,int timeout,int hostPid,long hostStart,bool verbatim,string nonce,string launchId,string proofPath) {
    IntPtr job=CreateJobObjectW(IntPtr.Zero,name); if(job==IntPtr.Zero) throw new Exception("Cannot create command process job");
    if(Marshal.GetLastWin32Error()==183) { CloseHandle(job); throw new Exception("Original process job already exists"); }
    PROCESS_INFORMATION process=new PROCESS_INFORMATION(); bool spawned=false;
    try {
      EXTENDED_LIMIT limits=new EXTENDED_LIMIT(); limits.basic.flags=0x2000;
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) throw new Exception("Cannot configure command process job");
      StringBuilder line=new StringBuilder(Quote(executable)); foreach(string arg in args) { if(arg.IndexOf('\0')>=0) throw new Exception("Invalid argument"); line.Append(' '); line.Append(verbatim?arg:Quote(arg)); }
      STARTUPINFOEX startup=new STARTUPINFOEX(); startup.startup.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.startup.flags=0x101;
      startup.startup.input=GetStdHandle(-10); startup.startup.output=GetStdHandle(-11); startup.startup.error=GetStdHandle(-12);
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
      startup.attributes=Marshal.AllocHGlobal(size); IntPtr jobValue=Marshal.AllocHGlobal(IntPtr.Size),handleValue=Marshal.AllocHGlobal(IntPtr.Size*3); bool initialized=false;
      try {
        if(!InitializeProcThreadAttributeList(startup.attributes,2,0,ref size)) throw new Exception("Cannot initialize process attributes"); initialized=true;
        Marshal.WriteIntPtr(jobValue,job);
        if(!UpdateProcThreadAttribute(startup.attributes,0,new IntPtr(0x2000d),jobValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw new Exception("Cannot set atomic process job");
        IntPtr[] handles={startup.startup.input,startup.startup.output,startup.startup.error};
        for(int i=0;i<3;i++) { if(!SetHandleInformation(handles[i],1,1)) throw new Exception("Cannot inherit owned stdio"); Marshal.WriteIntPtr(handleValue,i*IntPtr.Size,handles[i]); }
        if(!UpdateProcThreadAttribute(startup.attributes,0,new IntPtr(0x20002),handleValue,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero)) throw new Exception("Cannot fence inherited handles");
        if(!CreateProcessW(executable,line,IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,cwd,ref startup,out process)) throw new Exception("Cannot start contained command process");
      } finally { if(initialized) DeleteProcThreadAttributeList(startup.attributes); Marshal.FreeHGlobal(startup.attributes); Marshal.FreeHGlobal(jobValue); Marshal.FreeHGlobal(handleValue); }
      spawned=true;
      if(!String.IsNullOrEmpty(proofPath)) {
        Guid.Parse(nonce); Guid.Parse(launchId);
        long born,ended,kernel,user; if(!GetProcessTimes(process.process,out born,out ended,out kernel,out user)) throw new Exception("Cannot capture contained process birth");
        using(Process helper=Process.GetCurrentProcess()) {
          Save(proofPath,"{\"version\":1,\"nonce\":\""+nonce+"\",\"launchId\":\""+launchId+"\",\"rootPid\":"+process.processId+",\"rootStartedAt\":\""+DateTime.FromFileTimeUtc(born).Ticks+"\",\"helperPid\":"+helper.Id+",\"helperStartedAt\":\""+helper.StartTime.ToUniversalTime().Ticks+"\"}");
        }
      }
      if(ResumeThread(process.thread)==0xffffffff) throw new Exception("Cannot resume command process");
      Stopwatch elapsed=Stopwatch.StartNew(); bool aborted=false;
      while(WaitForSingleObject(process.process,50)==258) {
        // CIM's creation timestamp has microsecond precision; native FILETIME
        // retains 100 ns. Compare the same precision, retaining process birth.
        bool owner=true; try { owner=Process.GetProcessById(hostPid).StartTime.ToUniversalTime().Ticks/10==hostStart/10; } catch { owner=false; }
        if(timeout>0 && elapsed.ElapsedMilliseconds>=timeout || !owner) { aborted=true; break; }
      }
      uint code; if(!GetExitCodeProcess(process.process,out code)) throw new Exception("Cannot read command exit");
      if(!TerminateJobObject(job,aborted?71u:0u)) throw new Exception("Cannot stop command descendants");
      for(int i=0;i<200;i++) { if(Empty(job)) { Save(result,"{\"code\":"+(aborted?"null":code.ToString())+",\"aborted\":"+(aborted?"true":"false")+",\"failedToStart\":false,\"cleanupConfirmed\":true}"); return; } Thread.Sleep(25); }
      throw new Exception("Command descendants remain unconfirmed");
    } catch { if(!spawned) Save(result,"{\"code\":null,\"aborted\":false,\"failedToStart\":true,\"cleanupConfirmed\":true}"); throw; }
    finally { if(process.thread!=IntPtr.Zero) CloseHandle(process.thread); if(process.process!=IntPtr.Zero) CloseHandle(process.process); CloseHandle(job); }
  }
}
'@
$workcopyLoaded=$false
try {
  $cacheRoot=[IO.Path]::Combine($PSScriptRoot,'native-cache')
  if(-not [IO.Directory]::Exists($cacheRoot)) { [void][IO.Directory]::CreateDirectory($cacheRoot) }
  if(([IO.File]::GetAttributes($cacheRoot) -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
    $dllName=[IO.Path]::GetFileNameWithoutExtension($PSCommandPath)+'-'+[Environment]::Version.ToString()+'-'+[IntPtr]::Size+'.dll'
    $dllPath=[IO.Path]::Combine($cacheRoot,$dllName)
    if(-not [IO.File]::Exists($dllPath)) {
      $tmpPath=$dllPath+'.'+[Guid]::NewGuid().ToString('N')+'.tmp.dll'
      try {
        Add-Type -TypeDefinition $workcopySource -OutputAssembly $tmpPath -OutputType Library
        try { [IO.File]::Move($tmpPath,$dllPath) } catch { if([IO.File]::Exists($tmpPath)) { [IO.File]::Delete($tmpPath) } }
      } catch { if([IO.File]::Exists($tmpPath)) { try { [IO.File]::Delete($tmpPath) } catch {} } }
    }
    if([IO.File]::Exists($dllPath) -and (([IO.File]::GetAttributes($dllPath) -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
      [void][Reflection.Assembly]::LoadFrom($dllPath)
      $workcopyLoaded=$true
    }
  }
} catch {}
if(-not $workcopyLoaded) { Add-Type -TypeDefinition $workcopySource }
if($Mode -eq 'cleanup') {
  $limit=[DateTime]::UtcNow.AddSeconds(9)
  do {
    $proof=$null
    if($spec.proofPath -and (Test-Path -LiteralPath $spec.proofPath)) {
      $proof=Get-Content -LiteralPath $spec.proofPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if($proof.nonce -ne $spec.nonce -or $proof.launchId -ne $spec.launchId) { throw 'Original Job witness does not match' }
    }
    $clean=[TrellisWorkcopyCommand]::Clean([string]$spec.jobName)
    $nativeWrappers=[TrellisWorkcopyCommand]::FindWrappers($SpecPath,$PID)
    if($null -ne $nativeWrappers) {
      if($clean -and $proof) {
        foreach($wrapper in $nativeWrappers) {
          if($wrapper.ProcessId -eq $proof.helperPid -and ([long]$wrapper.CreatedTicks/10) -eq ([long]$proof.helperStartedAt/10)) {
            [TrellisWorkcopyCommand]::StopWitness([int]$proof.helperPid,[long]$proof.helperStartedAt)
          }
        }
      }
      if($clean -and $nativeWrappers.Length -eq 0) { [Console]::Out.WriteLine('{"cleaned":true}'); exit 0 }
    } else {
      $wrappers=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($SpecPath) -and ($_.CommandLine.Contains('-Mode run') -or $_.CommandLine.Contains('-Mode transport')) })
      if($clean -and $proof) {
        foreach($wrapper in $wrappers) {
          if($wrapper.ProcessId -eq $proof.helperPid -and ([long]$wrapper.CreationDate.ToUniversalTime().Ticks/10) -eq ([long]$proof.helperStartedAt/10)) {
            [TrellisWorkcopyCommand]::StopWitness([int]$proof.helperPid,[long]$proof.helperStartedAt)
          }
        }
      }
      if($clean -and $wrappers.Count -eq 0) { [Console]::Out.WriteLine('{"cleaned":true}'); exit 0 }
    }
    Start-Sleep -Milliseconds 25
  } while([DateTime]::UtcNow -lt $limit)
  [Console]::Out.WriteLine('{"cleaned":false}'); exit 0
}
$entered=$false
try {
  $command=Get-Command -Name ([string]$spec.executable) -CommandType Application -ErrorAction Stop | Select-Object -First 1
  if([IO.Path]::GetExtension($command.Source) -notin @('.exe','.com')) { throw 'A native executable is required' }
  $env:PSModulePath=$originalPSModulePath
  $entered=$true
  [TrellisWorkcopyCommand]::Run($command.Source,[string[]]$spec.args,[string]$spec.root,[string]$spec.jobName,[string]$spec.resultPath,[int]$spec.timeoutMs,[int]$spec.hostPid,[long]$spec.hostStart,[bool]$spec.windowsVerbatimArguments,[string]$spec.nonce,[string]$spec.launchId,[string]$spec.proofPath)
  if($Mode -eq 'transport') { $outcome=Get-Content -LiteralPath $spec.resultPath -Raw -Encoding UTF8 | ConvertFrom-Json; if($null -eq $outcome.code) { exit 71 }; exit ([int]$outcome.code) }
  exit 0
} catch {
  if(-not $entered) { [TrellisWorkcopyCommand]::Save([string]$spec.resultPath,'{"code":null,"aborted":false,"failedToStart":true,"cleanupConfirmed":true}') }
  [Console]::Error.WriteLine('Original command or process cleanup is unconfirmed; inspect its retained receipt.'); exit 71
}
`
