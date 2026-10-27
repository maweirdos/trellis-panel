param([Parameter(Mandatory=$true)][string]$ExecutableBase64,[Parameter(Mandatory=$true)][string]$EntryBase64)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
try {
  $nodeExecutable = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ExecutableBase64))
  $engineEntry = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EntryBase64))
  if (-not [IO.Path]::IsPathRooted($nodeExecutable) -or -not [IO.Path]::IsPathRooted($engineEntry) -or -not [IO.File]::Exists($nodeExecutable) -or -not [IO.File]::Exists($engineEntry)) { throw 'Invalid Pi entry' }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class TrellisPiJob {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public uint cb; public IntPtr reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,reserved2; public IntPtr reservedBytes,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint processId,threadId; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long processTime,jobTime; public uint flags; public UIntPtr minWorkingSet,maxWorkingSet; public uint activeProcessLimit; public UIntPtr affinity; public uint priorityClass,schedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOperations,writeOperations,otherOperations,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long userTime,kernelTime,periodUserTime,periodKernelTime; public uint faults,totalProcesses,activeProcesses,terminatedProcesses; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT limits,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out ACCOUNTING accounting,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string executable,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Run(string executable,string entry) {
    if(executable.IndexOfAny(new[]{'"','\0','\r','\n'})>=0 || entry.IndexOfAny(new[]{'"','\0','\r','\n'})>=0) throw new Exception("Invalid Pi arguments");
    IntPtr job=CreateJobObjectW(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Exception("Cannot create Pi process job");
    PROCESS_INFORMATION process=new PROCESS_INFORMATION();
    try {
      EXTENDED_LIMIT limits=new EXTENDED_LIMIT(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway permission.
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) throw new Exception("Cannot configure Pi process job");
      STARTUPINFO startup=new STARTUPINFO(); startup.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFO)); startup.flags=0x101; startup.show=0;
      startup.input=GetStdHandle(-10); startup.output=GetStdHandle(-11); startup.error=GetStdHandle(-12);
      if(!CreateProcessW(executable,new StringBuilder("\""+executable+"\" \""+entry+"\""),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref startup,out process)) throw new Exception("Cannot start Pi process");
      if(!AssignProcessToJobObject(job,process.process)) { TerminateProcess(process.process,70); throw new Exception("Cannot contain Pi process"); }
      if(ResumeThread(process.thread)==0xffffffff) throw new Exception("Cannot resume Pi process");
      if(WaitForSingleObject(process.process,0xffffffff)!=0) throw new Exception("Cannot wait for Pi process");
      uint code; if(!GetExitCodeProcess(process.process,out code)) throw new Exception("Cannot read Pi exit");
      if(!TerminateJobObject(job,0)) return 70;
      for(int i=0;i<250;i++) { ACCOUNTING accounting; if(!QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero)) return 70; if(accounting.activeProcesses==0) return (int)code; Thread.Sleep(20); }
      return 70;
    } finally { if(process.thread!=IntPtr.Zero) CloseHandle(process.thread); if(process.process!=IntPtr.Zero) CloseHandle(process.process); CloseHandle(job); }
  }
}
'@
  $engineExitCode = [TrellisPiJob]::Run($nodeExecutable,$engineEntry)
  exit $engineExitCode
} catch { [Console]::Error.WriteLine('Pi Windows process containment failed'); exit 70 }
