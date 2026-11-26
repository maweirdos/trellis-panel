/**
 * Windows 进程内 Win32 原生加速层（基于已安装的 koffi）。
 * 与 resources/daemon/windows-native.ps1、windows-protection.ps1 及
 * windows-lifecycle-native.cs 调用完全相同的内核 API 与数据格式，
 * 将高频单次 450ms–2360ms 的 PowerShell 冷启动压降至 <1ms；
 * 任何非 Windows 平台或异常情况返回 undefined，由调用方安全回退至既有脚本。
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, isAbsolute, join } from 'node:path'
import type { ProcessOwner } from '../../shared/daemon'

/** Windows FILETIME (1601-01-01) 到 .NET DateTime UTC Ticks (0001-01-01) 的精确偏移 */
const FILETIME_TO_DOTNET_TICKS = 504911232000000000n

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const SYNCHRONIZE = 0x00100000
const TOKEN_QUERY = 0x0008
const TOKEN_USER_INFO_CLASS = 1
const WAIT_OBJECT_0 = 0
const ERROR_INVALID_PARAMETER = 87
const ERROR_NOT_FOUND = 1168
const CRYPTPROTECT_UI_FORBIDDEN = 0x1
const FILE_ATTRIBUTE_REPARSE_POINT = 0x0400
const INVALID_FILE_ATTRIBUTES = 0xffffffff
const SE_FILE_OBJECT = 1
const OWNER_SECURITY_INFORMATION = 0x1
const DACL_SECURITY_INFORMATION = 0x4
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
const SE_DACL_PROTECTED = 0x1000
const ACL_REVISION = 2
const ACL_SIZE_INFORMATION_CLASS = 2
const ACCESS_ALLOWED_ACE_TYPE = 0
const OBJECT_INHERIT_ACE = 0x1
const CONTAINER_INHERIT_ACE = 0x2
const INHERIT_ONLY_ACE = 0x8
const REQUIRED_ACE_INHERIT_FLAGS = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
const FILE_ALL_ACCESS = 0x001f01ff
const JOB_OBJECT_QUERY = 0x0004
const JOB_OBJECT_TERMINATE = 0x0008
const PROCESS_TERMINATE = 0x0001
const ERROR_FILE_NOT_FOUND = 2
const CREATE_NEW_PROCESS_GROUP = 0x00000200
const CREATE_UNICODE_ENVIRONMENT = 0x00000400
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000
const CREATE_NO_WINDOW = 0x08000000
const STARTF_USESHOWWINDOW = 0x00000001
const SYSTEM_TIME_OF_DAY_INFORMATION = 3
const PROCESS_COMMAND_LINE_INFORMATION = 60
const TH32CS_SNAPPROCESS = 0x00000002

interface Win32Bindings {
  koffi: typeof import('koffi')
  unicodeStringType: string
  tokenUserType: string
  GetLastError: () => number
  GetCurrentProcess: () => unknown
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown
  CloseHandle: (handle: unknown) => boolean
  CloseHandlePtr: (handle: bigint) => boolean
  WaitForSingleObject: (handle: unknown, ms: number) => number
  TerminateProcess: (handle: unknown, exitCode: number) => boolean
  GetProcessTimes: (handle: unknown, created: Buffer, exited: Buffer, kernel: Buffer, user: Buffer) => boolean
  QueryFullProcessImageNameW: (handle: unknown, flags: number, name: Buffer, size: Uint32Array) => boolean
  CreateToolhelp32Snapshot: (flags: number, th32ProcessId: number) => bigint
  Process32FirstW: (snapshot: bigint, entry: Buffer) => boolean
  Process32NextW: (snapshot: bigint, entry: Buffer) => boolean
  LocalFree: (ptr: unknown) => unknown
  GetFileAttributesW: (path: string) => number
  OpenJobObjectW: (access: number, inherit: boolean, name: string) => unknown
  IsProcessInJob: (process: unknown, job: unknown, result: Int32Array) => boolean
  QueryInformationJobObject: (job: unknown, infoClass: number, info: Buffer, len: number, retLen: unknown | null) => boolean
  TerminateJobObject: (job: unknown, exitCode: number) => boolean
  CreateProcessW: (
    applicationName: string | null,
    commandLine: Buffer,
    processAttrs: unknown | null,
    threadAttrs: unknown | null,
    inheritHandles: boolean,
    creationFlags: number,
    environment: Buffer | null,
    currentDirectory: string | null,
    startupInfo: Buffer,
    processInfo: Buffer
  ) => boolean
  OpenProcessToken: (process: unknown, access: number, tokenOut: unknown[]) => boolean
  GetTokenInformation: (token: unknown, infoClass: number, info: Buffer | null, len: number, retLen: Uint32Array) => boolean
  IsValidSid: (sid: unknown) => boolean
  GetLengthSid: (sid: unknown) => number
  ConvertSidToStringSidW: (sid: unknown, strOut: Array<string | null>) => boolean
  ConvertSidToStringSidWPtr: (sid: bigint, strOut: Array<string | null>) => boolean
  GetNamedSecurityInfoW: (
    objectName: string,
    objectType: number,
    securityInfo: number,
    ppsidOwner: unknown[],
    ppsidGroup: unknown | null,
    ppDacl: unknown[],
    ppSacl: unknown | null,
    ppSecurityDescriptor: unknown[]
  ) => number
  SetNamedSecurityInfoW: (
    objectName: string,
    objectType: number,
    securityInfo: number,
    psidOwner: unknown | null,
    psidGroup: unknown | null,
    pDacl: Buffer | null,
    pSacl: unknown | null
  ) => number
  InitializeAcl: (acl: Buffer, length: number, revision: number) => boolean
  AddAccessAllowedAceEx: (acl: Buffer, revision: number, flags: number, accessMask: number, sid: Buffer) => boolean
  GetSecurityDescriptorControl: (sd: unknown, controlOut: Uint16Array, revisionOut: Uint32Array) => boolean
  GetAclInformation: (acl: unknown, info: Buffer, len: number, infoClass: number) => boolean
  GetAce: (acl: unknown, index: number, aceOut: unknown[]) => boolean
  CryptProtectData: (
    dataIn: { cbData: number; pbData: Buffer },
    description: string | null,
    entropy: { cbData: number; pbData: Buffer } | null,
    reserved: unknown | null,
    prompt: unknown | null,
    flags: number,
    dataOut: { cbData: number; pbData: unknown }
  ) => boolean
  CryptUnprotectData: (
    dataIn: { cbData: number; pbData: Buffer },
    description: unknown | null,
    entropy: { cbData: number; pbData: Buffer } | null,
    reserved: unknown | null,
    prompt: unknown | null,
    flags: number,
    dataOut: { cbData: number; pbData: unknown }
  ) => boolean
  NtQuerySystemInformation: (infoClass: number, info: Buffer, len: number, retLen: Uint32Array) => number
  NtQueryInformationProcess: (process: unknown, infoClass: number, info: Buffer | null, len: number, retLen: Uint32Array) => number
  CommandLineToArgvW: (cmdLine: string, numArgsOut: Int32Array) => unknown
}

interface SharedWin32FastState {
  bindings?: Win32Bindings | null
  selfIdentity?: ProcessOwner
  selfSidBytes?: Buffer
}

const SHARED_WIN32_FAST_KEY = Symbol.for('crux.win32.fast.state.v2')

function sharedState(): SharedWin32FastState {
  const globalStore = globalThis as Record<symbol, SharedWin32FastState | undefined>
  let state = globalStore[SHARED_WIN32_FAST_KEY]
  if (!state) {
    state = {}
    globalStore[SHARED_WIN32_FAST_KEY] = state
  }
  return state
}

function resolveKoffiModule(): typeof import('koffi') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('koffi') as typeof import('koffi')
  } catch (primaryError) {
    // 打包版 electron-builder 排除了 app.asar 内的重复 koffi，由 resources/speech/node_modules/koffi 统一携带 N-API 二进制。
    if (process.resourcesPath) {
      const packagedSpeechEntry = join(process.resourcesPath, 'speech', 'worker.mjs')
      if (existsSync(packagedSpeechEntry)) {
        return createRequire(packagedSpeechEntry)('koffi') as typeof import('koffi')
      }
    }
    throw primaryError
  }
}

function loadBindings(): Win32Bindings | null {
  const state = sharedState()
  if (state.bindings !== undefined) return state.bindings
  if (process.platform !== 'win32') {
    state.bindings = null
    return null
  }
  try {
    const koffi = resolveKoffiModule()
    const kernel32 = koffi.load('kernel32.dll')
    const advapi32 = koffi.load('advapi32.dll')
    const crypt32 = koffi.load('crypt32.dll')
    const ntdll = koffi.load('ntdll.dll')
    const shell32 = koffi.load('shell32.dll')

    // 受管 GUI 同一 Electron 进程会先后加载 gui-scope.js 与 gui.js 两个独立 bundle，
    // koffi 原生插件在进程级维护全局类型注册表：除通过 Symbol.for 共享绑定外，
    // 自定义类型名附带独立实例后缀以彻底杜绝任何跨 bundle 重名冲突。
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const localStrType = `CRUX_LOCAL_STR16_${suffix}`
    const nativePtrType = `CRUX_NATIVE_PTR_${suffix}`
    const dataBlobType = `CRUX_DATA_BLOB_${suffix}`
    const unicodeStringType = `CRUX_UNICODE_STRING_${suffix}`
    const tokenUserType = `CRUX_TOKEN_USER_${suffix}`

    const LocalFree = kernel32.func('void * __stdcall LocalFree(void *)')
    // 自动解码并由 Win32 LocalFree 释放 ConvertSidToStringSidW 分配的宽字符串
    const LocalStr16 = koffi.disposable(localStrType, 'str16', (ptr: unknown) => {
      if (ptr) LocalFree(ptr)
    })
    const NativePtr = koffi.pointer(nativePtrType, koffi.opaque())
    const DataBlob = koffi.struct(dataBlobType, {
      cbData: 'uint32',
      pbData: 'void *'
    })
    const UnicodeString = koffi.struct(unicodeStringType, {
      Length: 'uint16',
      MaximumLength: 'uint16',
      Buffer: nativePtrType
    })
    const TokenUser = koffi.struct(tokenUserType, {
      Sid: 'void *',
      Attributes: 'uint32'
    })

    state.bindings = {
      koffi,
      unicodeStringType,
      tokenUserType,
      GetLastError: kernel32.func('uint32 __stdcall GetLastError()'),
      GetCurrentProcess: kernel32.func(`${nativePtrType} __stdcall GetCurrentProcess()`),
      OpenProcess: kernel32.func(`${nativePtrType} __stdcall OpenProcess(uint32, bool, uint32)`),
      CloseHandle: kernel32.func(`bool __stdcall CloseHandle(${nativePtrType})`),
      CloseHandlePtr: kernel32.func('bool __stdcall CloseHandle(uintptr)'),
      WaitForSingleObject: kernel32.func(`uint32 __stdcall WaitForSingleObject(${nativePtrType}, uint32)`),
      TerminateProcess: kernel32.func(`bool __stdcall TerminateProcess(${nativePtrType}, uint32)`),
      GetProcessTimes: kernel32.func(`bool __stdcall GetProcessTimes(${nativePtrType}, void *, void *, void *, void *)`),
      QueryFullProcessImageNameW: kernel32.func(`bool __stdcall QueryFullProcessImageNameW(${nativePtrType}, uint32, void *, _Inout_ uint32 *)`),
      CreateToolhelp32Snapshot: kernel32.func('uintptr __stdcall CreateToolhelp32Snapshot(uint32, uint32)'),
      Process32FirstW: kernel32.func('bool __stdcall Process32FirstW(uintptr, void *)'),
      Process32NextW: kernel32.func('bool __stdcall Process32NextW(uintptr, void *)'),
      LocalFree,
      GetFileAttributesW: kernel32.func('uint32 __stdcall GetFileAttributesW(str16)'),
      OpenJobObjectW: kernel32.func(`${nativePtrType} __stdcall OpenJobObjectW(uint32, bool, str16)`),
      IsProcessInJob: kernel32.func(`bool __stdcall IsProcessInJob(${nativePtrType}, ${nativePtrType}, _Out_ int32 *)`),
      QueryInformationJobObject: kernel32.func(`bool __stdcall QueryInformationJobObject(${nativePtrType}, uint32, void *, uint32, void *)`),
      TerminateJobObject: kernel32.func(`bool __stdcall TerminateJobObject(${nativePtrType}, uint32)`),
      CreateProcessW: kernel32.func(
        'bool __stdcall CreateProcessW(str16, void *, void *, void *, bool, uint32, void *, str16, void *, void *)'
      ),
      OpenProcessToken: advapi32.func(`bool __stdcall OpenProcessToken(${nativePtrType}, uint32, _Out_ ${nativePtrType} *)`),
      GetTokenInformation: advapi32.func(`bool __stdcall GetTokenInformation(${nativePtrType}, uint32, void *, uint32, _Out_ uint32 *)`),
      IsValidSid: advapi32.func('bool __stdcall IsValidSid(void *)'),
      GetLengthSid: advapi32.func('uint32 __stdcall GetLengthSid(void *)'),
      ConvertSidToStringSidW: advapi32.func(`bool __stdcall ConvertSidToStringSidW(void *, _Out_ ${localStrType} *)`),
      ConvertSidToStringSidWPtr: advapi32.func(`bool __stdcall ConvertSidToStringSidW(uintptr, _Out_ ${localStrType} *)`),
      GetNamedSecurityInfoW: advapi32.func(
        `uint32 __stdcall GetNamedSecurityInfoW(str16, uint32, uint32, _Out_ ${nativePtrType} *, void *, _Out_ ${nativePtrType} *, void *, _Out_ ${nativePtrType} *)`
      ),
      SetNamedSecurityInfoW: advapi32.func(
        'uint32 __stdcall SetNamedSecurityInfoW(str16, uint32, uint32, void *, void *, void *, void *)'
      ),
      InitializeAcl: advapi32.func('bool __stdcall InitializeAcl(void *, uint32, uint32)'),
      AddAccessAllowedAceEx: advapi32.func('bool __stdcall AddAccessAllowedAceEx(void *, uint32, uint32, uint32, void *)'),
      GetSecurityDescriptorControl: advapi32.func(
        `bool __stdcall GetSecurityDescriptorControl(${nativePtrType}, _Out_ uint16 *, _Out_ uint32 *)`
      ),
      GetAclInformation: advapi32.func(`bool __stdcall GetAclInformation(${nativePtrType}, void *, uint32, uint32)`),
      GetAce: advapi32.func(`bool __stdcall GetAce(${nativePtrType}, uint32, _Out_ ${nativePtrType} *)`),
      CryptProtectData: crypt32.func(
        `bool __stdcall CryptProtectData(_In_ ${dataBlobType} *, str16, _In_ ${dataBlobType} *, void *, void *, uint32, _Out_ ${dataBlobType} *)`
      ),
      CryptUnprotectData: crypt32.func(
        `bool __stdcall CryptUnprotectData(_In_ ${dataBlobType} *, void *, _In_ ${dataBlobType} *, void *, void *, uint32, _Out_ ${dataBlobType} *)`
      ),
      NtQuerySystemInformation: ntdll.func('int32 __stdcall NtQuerySystemInformation(uint32, void *, uint32, _Out_ uint32 *)'),
      NtQueryInformationProcess: ntdll.func(`int32 __stdcall NtQueryInformationProcess(${nativePtrType}, uint32, void *, uint32, _Out_ uint32 *)`),
      CommandLineToArgvW: shell32.func(`${nativePtrType} __stdcall CommandLineToArgvW(str16, _Out_ int32 *)`)
    }
    void LocalStr16
    void NativePtr
    void DataBlob
    void UnicodeString
    void TokenUser
    return state.bindings
  } catch {
    state.bindings = null
    return null
  }
}

function isNullPtr(ptr: unknown): boolean {
  if (!ptr) return true
  if (typeof ptr === 'bigint') return ptr === 0n
  if (typeof ptr === 'number') return ptr === 0
  const bindings = loadBindings()
  if (!bindings) return true
  try {
    return bindings.koffi.address(ptr) === 0n
  } catch {
    return false
  }
}

function sidToString(bindings: Win32Bindings, sidPtr: unknown): string | null {
  if (isNullPtr(sidPtr)) return null
  const out: Array<string | null> = [null]
  const ok = typeof sidPtr === 'bigint'
    ? bindings.ConvertSidToStringSidWPtr(sidPtr, out)
    : bindings.ConvertSidToStringSidW(sidPtr, out)
  if (!ok || !out[0]) return null
  return out[0]
}

function readProcessOwnerFromHandle(bindings: Win32Bindings, handle: unknown, pid: number): ProcessOwner | null {
  const created = Buffer.alloc(8)
  const exited = Buffer.alloc(8)
  const kernel = Buffer.alloc(8)
  const user = Buffer.alloc(8)
  if (!bindings.GetProcessTimes(handle, created, exited, kernel, user)) return null
  const filetime = created.readBigUInt64LE(0)
  // 与 windows-pipe.ps1 / Win32_Process DMTF 微秒精度保持一致（截断百纳秒末位）
  const ticks = ((filetime + FILETIME_TO_DOTNET_TICKS) / 10n) * 10n

  const maxChars = 32768
  const pathBuf = Buffer.alloc(maxChars * 2)
  const sizeOut = new Uint32Array([maxChars])
  if (!bindings.QueryFullProcessImageNameW(handle, 0, pathBuf, sizeOut) || sizeOut[0] === 0) return null
  const executable = pathBuf.subarray(0, sizeOut[0] * 2).toString('utf16le')

  const tokenOut: unknown[] = [null]
  if (!bindings.OpenProcessToken(handle, TOKEN_QUERY, tokenOut) || isNullPtr(tokenOut[0])) return null
  try {
    const needed = new Uint32Array([0])
    bindings.GetTokenInformation(tokenOut[0], TOKEN_USER_INFO_CLASS, null, 0, needed)
    if (needed[0] < 8 || needed[0] > 65536) return null
    const infoBuf = Buffer.alloc(needed[0])
    if (!bindings.GetTokenInformation(tokenOut[0], TOKEN_USER_INFO_CLASS, infoBuf, needed[0], needed)) return null
    // TOKEN_USER 首字段为 PSID 指针
    const sidAddr = process.arch === 'ia32' ? BigInt(infoBuf.readUInt32LE(0)) : infoBuf.readBigUInt64LE(0)
    const userId = sidToString(bindings, sidAddr)
    if (!userId) return null
    return { pid, startedAt: ticks.toString(), userId, executable }
  } finally {
    bindings.CloseHandle(tokenOut[0])
  }
}

/**
 * 实时查询进程身份（PID + 精确内核启动 ticks + 用户 SID + 物理可执行路径）。
 * - 当前进程自身 (`pid === process.pid`) 身份在整个进程生命周期内不可变，首次内核查询后缓存。
 * - 其他进程每次均执行实时 Win32 内核查询，绝不复用旧快照。
 * - 返回 `null` 表示进程不存在或已退出；返回 `undefined` 表示需回退到 PowerShell。
 */
export function fastProcessIdentity(pid: number): ProcessOwner | null | undefined {
  const state = sharedState()
  if (pid === process.pid && state.selfIdentity) return { ...state.selfIdentity }
  const bindings = loadBindings()
  if (!bindings) return undefined
  try {
    const handle = bindings.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, pid)
    if (isNullPtr(handle)) {
      const error = bindings.GetLastError()
      if (error === ERROR_INVALID_PARAMETER || error === ERROR_NOT_FOUND) return null
      return undefined
    }
    try {
      if (bindings.WaitForSingleObject(handle, 0) === WAIT_OBJECT_0) return null
      const owner = readProcessOwnerFromHandle(bindings, handle, pid)
      if (!owner) return undefined
      if (pid === process.pid) state.selfIdentity = { ...owner }
      return owner
    } finally {
      bindings.CloseHandle(handle)
    }
  } catch {
    return undefined
  }
}

function readSelfSidBytes(bindings: Win32Bindings): Buffer | null {
  const state = sharedState()
  if (state.selfSidBytes) return state.selfSidBytes
  const tokenOut: unknown[] = [null]
  if (!bindings.OpenProcessToken(bindings.GetCurrentProcess(), TOKEN_QUERY, tokenOut) || isNullPtr(tokenOut[0])) return null
  try {
    const needed = new Uint32Array([0])
    bindings.GetTokenInformation(tokenOut[0], TOKEN_USER_INFO_CLASS, null, 0, needed)
    if (needed[0] < 8 || needed[0] > 65536) return null
    const infoBuf = Buffer.alloc(needed[0])
    if (!bindings.GetTokenInformation(tokenOut[0], TOKEN_USER_INFO_CLASS, infoBuf, needed[0], needed)) return null
    const tokenUser = bindings.koffi.decode(infoBuf, bindings.tokenUserType) as { Sid: unknown }
    if (isNullPtr(tokenUser.Sid) || !bindings.IsValidSid(tokenUser.Sid)) return null
    const sidLen = bindings.GetLengthSid(tokenUser.Sid)
    if (sidLen < 8 || sidLen > 256) return null
    const sidBytes = Buffer.from(bindings.koffi.decode(tokenUser.Sid, bindings.koffi.array('uint8', sidLen)) as Uint8Array)
    state.selfSidBytes = sidBytes
    return sidBytes
  } catch {
    return null
  } finally {
    bindings.CloseHandle(tokenOut[0])
  }
}

/**
 * 进程内直接为当前用户拥有的非重解析目录写入受保护独占 DACL（SE_DACL_PROTECTED + 单条 Allow FullControl ACE），
 * 与 resources/daemon/windows-native.ps1 -Operation secure-directory 完全同语义并做二次回读核验。
 * 返回 false 时由调用方回退到 PowerShell。
 */
export function fastProtectDirectory(directory: string): boolean {
  const bindings = loadBindings()
  if (!bindings) return false
  try {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    const attrs = bindings.GetFileAttributesW(directory)
    if (attrs === INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) return false

    const self = fastProcessIdentity(process.pid)
    const sidBytes = readSelfSidBytes(bindings)
    if (!self || !sidBytes) return false

    const ownerOut: unknown[] = [null]
    const daclOut: unknown[] = [null]
    const sdOut: unknown[] = [null]
    const rc = bindings.GetNamedSecurityInfoW(
      directory,
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      ownerOut,
      null,
      daclOut,
      null,
      sdOut
    )
    if (rc !== 0 || isNullPtr(sdOut[0])) return false
    try {
      // 严禁篡改非当前用户拥有的目录（与 windows-native.ps1:17 完全对齐）
      if (sidToString(bindings, ownerOut[0]) !== self.userId) return false
    } finally {
      bindings.LocalFree(sdOut[0])
    }

    const aclSize = Math.max(64, (8 + 8 + sidBytes.length + 3) & ~3)
    const aclBuf = Buffer.alloc(aclSize)
    if (!bindings.InitializeAcl(aclBuf, aclSize, ACL_REVISION)) return false
    if (!bindings.AddAccessAllowedAceEx(aclBuf, ACL_REVISION, CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE, FILE_ALL_ACCESS, sidBytes)) {
      return false
    }
    const setRc = bindings.SetNamedSecurityInfoW(
      directory,
      SE_FILE_OBJECT,
      (DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION) >>> 0,
      null,
      null,
      aclBuf,
      null
    )
    if (setRc !== 0) return false
    return fastIsDirectoryProtected(directory)
  } catch {
    return false
  }
}

/**
 * 实时核验目录是否已受当前用户独占保护（非重解析点、Owner=当前用户、SE_DACL_PROTECTED、
 * 且 DACL 仅含 1 条当前用户的 Allow FullControl ACE）。
 * 返回 true 时完全等价于 windows-native.ps1 的校验结果，可跳过 PowerShell；
 * 返回 false 时必须由 PowerShell 执行 ACL 修复与校验。
 */
export function fastIsDirectoryProtected(directory: string): boolean {
  const bindings = loadBindings()
  if (!bindings) return false
  try {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    const attrs = bindings.GetFileAttributesW(directory)
    if (attrs === INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) return false

    const self = fastProcessIdentity(process.pid)
    if (!self) return false

    const ownerOut: unknown[] = [null]
    const daclOut: unknown[] = [null]
    const sdOut: unknown[] = [null]
    const rc = bindings.GetNamedSecurityInfoW(
      directory,
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      ownerOut,
      null,
      daclOut,
      null,
      sdOut
    )
    if (rc !== 0 || isNullPtr(sdOut[0])) return false
    try {
      const ownerSid = sidToString(bindings, ownerOut[0])
      if (ownerSid !== self.userId) return false

      const control = new Uint16Array([0])
      const revision = new Uint32Array([0])
      if (!bindings.GetSecurityDescriptorControl(sdOut[0], control, revision)) return false
      if ((control[0] & SE_DACL_PROTECTED) === 0) return false
      if (isNullPtr(daclOut[0])) return false

      const aclInfo = Buffer.alloc(12) // ACL_SIZE_INFORMATION: 3 * DWORD
      if (!bindings.GetAclInformation(daclOut[0], aclInfo, 12, ACL_SIZE_INFORMATION_CLASS)) return false
      const aceCount = aclInfo.readUInt32LE(0)
      if (aceCount !== 1) return false

      const aceOut: unknown[] = [null]
      if (!bindings.GetAce(daclOut[0], 0, aceOut) || isNullPtr(aceOut[0])) return false
      // ACCESS_ALLOWED_ACE: [0]=AceType(u8), [1]=AceFlags(u8), [2..3]=AceSize(u16), [4..7]=Mask(u32), [8..]=SidStart
      const aceHead = Buffer.from(bindings.koffi.decode(aceOut[0], bindings.koffi.array('uint8', 8)) as Uint8Array)
      const aceType = aceHead[0]
      const aceFlags = aceHead[1]
      const aceSize = aceHead.readUInt16LE(2)
      const mask = aceHead.readUInt32LE(4)
      const hasInheritFlags = (aceFlags & REQUIRED_ACE_INHERIT_FLAGS) === REQUIRED_ACE_INHERIT_FLAGS && (aceFlags & INHERIT_ONLY_ACE) === 0
      if (aceType !== ACCESS_ALLOWED_ACE_TYPE || !hasInheritFlags || aceSize < 16 || aceSize > 264 || (mask & FILE_ALL_ACCESS) !== FILE_ALL_ACCESS) {
        return false
      }

      const fullAce = Buffer.from(bindings.koffi.decode(aceOut[0], bindings.koffi.array('uint8', aceSize)) as Uint8Array)
      const sidBytes = fullAce.subarray(8)
      if (!bindings.IsValidSid(sidBytes)) return false
      const aceSid = sidToString(bindings, sidBytes)
      return aceSid === self.userId
    } finally {
      bindings.LocalFree(sdOut[0])
    }
  } catch {
    return false
  }
}

/**
 * 进程内调用 Win32 DPAPI（CurrentUser scope，CRYPTPROTECT_UI_FORBIDDEN）。
 * 与 .NET ProtectedData.Protect/Unprotect(..., CurrentUser) 二进制完全兼容。
 * 返回 undefined 表示无法走快速通道，应回退到 windows-protection.ps1。
 */
export function fastDpapi(operation: 'protect' | 'unprotect', value: Buffer, entropy: string): Buffer | undefined {
  if (!value.length || value.length > 16384 || !/^(?:[a-f0-9]{64})?$/.test(entropy)) return undefined
  if (operation === 'protect' && (value.length !== 32 || entropy.length !== 64)) return undefined
  const bindings = loadBindings()
  if (!bindings) return undefined
  const entropyBuf = entropy ? Buffer.from(entropy, 'utf8') : null
  const inBlob = { cbData: value.length, pbData: value }
  const entropyBlob = entropyBuf ? { cbData: entropyBuf.length, pbData: entropyBuf } : null
  const outBlob: { cbData: number; pbData: unknown } = { cbData: 0, pbData: null }
  try {
    const ok = operation === 'protect'
      ? bindings.CryptProtectData(inBlob, null, entropyBlob, null, null, CRYPTPROTECT_UI_FORBIDDEN, outBlob)
      : bindings.CryptUnprotectData(inBlob, null, entropyBlob, null, null, CRYPTPROTECT_UI_FORBIDDEN, outBlob)
    if (!ok || outBlob.cbData <= 0 || outBlob.cbData > 16384 || isNullPtr(outBlob.pbData)) return undefined
    try {
      const copied = Buffer.from(bindings.koffi.decode(outBlob.pbData, bindings.koffi.array('uint8', outBlob.cbData)) as Uint8Array)
      if (operation === 'unprotect' && copied.length !== 32) {
        copied.fill(0)
        return undefined
      }
      return copied
    } finally {
      // 释放前清零非托管明文/密文内存
      try {
        const zero = Buffer.alloc(outBlob.cbData)
        bindings.koffi.encode(outBlob.pbData, bindings.koffi.array('uint8', outBlob.cbData), zero)
      } catch { /* ignore */ }
      bindings.LocalFree(outBlob.pbData)
    }
  } catch {
    return undefined
  } finally {
    entropyBuf?.fill(0)
  }
}

/**
 * 快速核验当前受管 GUI 进程确实位于预期的 Windows Job 中且监护器存活。
 * 返回 true 表示通过核验；返回 false 时交由原 lifecycle-native controller 完整裁决。
 */
export function fastVerifyCurrentGuiJob(jobName: string, guardian: ProcessOwner): boolean {
  const bindings = loadBindings()
  if (!bindings) return false
  try {
    const job = bindings.OpenJobObjectW(JOB_OBJECT_QUERY, false, jobName)
    if (isNullPtr(job)) return false
    try {
      const inJob = new Int32Array([0])
      if (!bindings.IsProcessInJob(bindings.GetCurrentProcess(), job, inJob) || inJob[0] === 0) return false
    } finally {
      bindings.CloseHandle(job)
    }
    const actualGuardian = fastProcessIdentity(guardian.pid)
    if (!actualGuardian) return false
    const sameBirth = BigInt(actualGuardian.startedAt) / 10n === BigInt(guardian.startedAt) / 10n
    return actualGuardian.pid === guardian.pid
      && sameBirth
      && actualGuardian.userId === guardian.userId
      && actualGuardian.executable.toLowerCase() === guardian.executable.toLowerCase()
  } catch {
    return false
  }
}

/**
 * 直接调用 ntdll!NtQuerySystemInformation(SystemTimeOfDayInformation) 获取内核精确启动 UTC Ticks，
 * 与 windows-lifecycle-native.cs:BootStartedAt() 完全同源。
 */
export function fastKernelBootTicks(): string | undefined {
  const bindings = loadBindings()
  if (!bindings) return undefined
  try {
    const buf = Buffer.alloc(48)
    const retLen = new Uint32Array([0])
    const status = bindings.NtQuerySystemInformation(SYSTEM_TIME_OF_DAY_INFORMATION, buf, 48, retLen)
    if (status < 0 || retLen[0] < 16) return undefined
    const boot = buf.readBigInt64LE(0)
    const now = buf.readBigInt64LE(8)
    if (boot <= 0n || now <= boot) return undefined
    return (boot + FILETIME_TO_DOTNET_TICKS).toString()
  } catch {
    return undefined
  }
}

function quoteWin32Arg(value: string): string {
  if (value.includes('\0')) throw new Error('Invalid NUL in Win32 argument')
  let out = '"'
  let slashes = 0
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === '\\') {
      slashes += 1
      continue
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"'
    } else {
      out += '\\'.repeat(slashes) + ch
    }
    slashes = 0
  }
  out += '\\'.repeat(slashes * 2) + '"'
  return out
}

function encodeWin32Environment(env?: NodeJS.ProcessEnv): Buffer | null {
  if (!env) return null
  const deduped = new Map<string, [string, string]>()
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key || key.includes('=') || key.includes('\0') || value.includes('\0')) continue
    deduped.set(key.toUpperCase(), [key, value])
  }
  const entries = [...deduped.values()]
  // Win32 CreateProcessW 要求按 UTF-16 码点大写升序（CompareStringOrdinal）排列，不能使用受区域影响的 localeCompare。
  entries.sort((a, b) => {
    const ua = a[0].toUpperCase()
    const ub = b[0].toUpperCase()
    return ua < ub ? -1 : ua > ub ? 1 : 0
  })
  const block = entries.length === 0 ? '\0\0' : entries.map(([k, v]) => `${k}=${v}\0`).join('') + '\0'
  return Buffer.from(block, 'utf16le')
}

/**
 * 进程内直接调用 Win32 CreateProcessW 拉起无控制台、脱离进程组（可选 BREAKAWAY）的监护器进程，
 * 与 CruxLifecycleNative.Detach 完全一致，省去外层跳板 PowerShell 启动与 C# 编译耗时。
 */
export function fastDetachProcess(
  executable: string,
  args: readonly string[],
  options: { breakaway?: boolean; env?: NodeJS.ProcessEnv } = {}
): ProcessOwner | undefined {
  const bindings = loadBindings()
  if (!bindings) return undefined
  try {
    const commandLine = [quoteWin32Arg(executable), ...args.map(quoteWin32Arg)].join(' ')
    if (commandLine.length >= 32767) return undefined
    // CreateProcessW 要求 lpCommandLine 指向可写宽字符缓冲区并以 NUL 结尾
    const cmdBuf = Buffer.from(commandLine + '\0', 'utf16le')
    const envBuf = encodeWin32Environment(options.env)

    const is32 = process.arch === 'ia32'
    const si = Buffer.alloc(is32 ? 68 : 104)
    si.writeUInt32LE(si.length, 0) // cb
    si.writeUInt32LE(STARTF_USESHOWWINDOW, is32 ? 44 : 60) // dwFlags
    si.writeUInt16LE(0, is32 ? 48 : 64) // wShowWindow = SW_HIDE

    const pi = Buffer.alloc(is32 ? 16 : 24)
    let flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    if (options.breakaway) flags |= CREATE_BREAKAWAY_FROM_JOB
    if (envBuf) flags |= CREATE_UNICODE_ENVIRONMENT

    const ok = bindings.CreateProcessW(executable, cmdBuf, null, null, false, flags, envBuf, null, si, pi)
    if (!ok) return undefined

    const hProcess = is32 ? BigInt(pi.readUInt32LE(0)) : pi.readBigUInt64LE(0)
    const hThread = is32 ? BigInt(pi.readUInt32LE(4)) : pi.readBigUInt64LE(8)
    const pid = pi.readUInt32LE(is32 ? 8 : 16)
    try {
      // 在关闭 hProcess 之前读取身份，确保 PID 归属内核对象尚未被回收。
      const identity = fastProcessIdentity(pid)
      return identity ?? undefined
    } finally {
      if (hThread !== 0n) bindings.CloseHandlePtr(hThread)
      if (hProcess !== 0n) bindings.CloseHandlePtr(hProcess)
    }
  } catch {
    return undefined
  }
}

/**
 * 进程内直接清理受管 ACP Windows Job 并核验 helper 退出（等价于 TrellisWorkcopyCommand.Clean + StopWitness）。
 * 返回 true 表示内核已证实 Job 清空且原 helper 进程退出；返回 undefined 时由调用方回退到 PowerShell 完整清理。
 */
export async function fastCleanAcpJob(
  jobName: string,
  proof: { helperPid: number; helperStartedAt: string }
): Promise<boolean | undefined> {
  const bindings = loadBindings()
  if (!bindings) return undefined
  try {
    const job = bindings.OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, jobName)
    if (isNullPtr(job)) {
      if (bindings.GetLastError() !== ERROR_FILE_NOT_FOUND) return undefined
    } else {
      try {
        const accounting = Buffer.alloc(48)
        const isEmpty = (): boolean | null => {
          if (!bindings.QueryInformationJobObject(job, 1, accounting, 48, null)) return null
          return accounting.readUInt32LE(40) === 0
        }
        let empty = isEmpty()
        if (empty === null) return undefined
        if (!empty) {
          if (!bindings.TerminateJobObject(job, 71)) return undefined
          for (let i = 0; i < 150; i += 1) {
            empty = isEmpty()
            if (empty === true) break
            if (empty === null) return undefined
            await new Promise(resolve => setTimeout(resolve, 15))
          }
          if (!empty) return undefined
        }
      } finally {
        bindings.CloseHandle(job)
      }
    }

    const expectedTicks = BigInt(proof.helperStartedAt) / 10n
    const helper = bindings.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, false, proof.helperPid)
    if (isNullPtr(helper)) {
      const error = bindings.GetLastError()
      if (error === ERROR_INVALID_PARAMETER || error === ERROR_NOT_FOUND) return true
      return undefined
    }
    try {
      const created = Buffer.alloc(8)
      const exited = Buffer.alloc(8)
      const kernel = Buffer.alloc(8)
      const user = Buffer.alloc(8)
      if (!bindings.GetProcessTimes(helper, created, exited, kernel, user)) return undefined
      const actualTicks = (created.readBigUInt64LE(0) + FILETIME_TO_DOTNET_TICKS) / 10n
      // 出生时间不匹配说明原 helper 已退出且 PID 已被复用，绝不触碰新进程。
      if (actualTicks !== expectedTicks) return true
      if (bindings.WaitForSingleObject(helper, 0) === WAIT_OBJECT_0) return true
      if (!bindings.TerminateProcess(helper, 71)) {
        if (bindings.WaitForSingleObject(helper, 0) === WAIT_OBJECT_0) return true
        return undefined
      }
      for (let i = 0; i < 120; i += 1) {
        if (bindings.WaitForSingleObject(helper, 0) === WAIT_OBJECT_0) return true
        await new Promise(resolve => setTimeout(resolve, 15))
      }
      return undefined
    } finally {
      bindings.CloseHandle(helper)
    }
  } catch {
    return undefined
  }
}

function canonicalWinPath(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

function readProcessArgvFromHandle(bindings: Win32Bindings, handle: unknown): string[] | null {
  const needed = new Uint32Array([0])
  bindings.NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, null, 0, needed)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cap = needed[0]
    if (cap < 16 || cap > 131072) return null
    const buf = Buffer.alloc(cap)
    const status = bindings.NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, buf, cap, needed)
    if (status < 0) {
      if (needed[0] > cap) continue
      return null
    }
    const ustr = bindings.koffi.decode(buf, bindings.unicodeStringType) as {
      Length: number
      MaximumLength: number
      Buffer: unknown
    }
    const byteLen = ustr.Length
    if (byteLen === 0 || byteLen > 65534 || byteLen % 2 !== 0 || isNullPtr(ustr.Buffer)) return null
    if (bindings.WaitForSingleObject(handle, 0) === WAIT_OBJECT_0) return null
    const headerBytes = process.arch === 'ia32' ? 8 : 16
    const bufAddr = bindings.koffi.address(buf)
    const strAddr = bindings.koffi.address(ustr.Buffer)
    let cmdLine: string
    if (bufAddr > 0n && strAddr >= bufAddr + BigInt(headerBytes) && strAddr + BigInt(byteLen) <= bufAddr + BigInt(cap)) {
      const offset = Number(strAddr - bufAddr)
      cmdLine = buf.subarray(offset, offset + byteLen).toString('utf16le')
    } else {
      return null
    }
    const argcOut = new Int32Array([0])
    const argvPtr = bindings.CommandLineToArgvW(cmdLine, argcOut)
    if (isNullPtr(argvPtr) || argcOut[0] <= 0 || argcOut[0] > 4096) return null
    try {
      const count = argcOut[0]
      const decoded = bindings.koffi.decode(argvPtr, bindings.koffi.array('str16', count)) as string[]
      if (!Array.isArray(decoded) || decoded.some(item => typeof item !== 'string')) return null
      return decoded
    } finally {
      bindings.LocalFree(argvPtr)
    }
  }
  return null
}

function enumerateProcessSnapshot(bindings: Win32Bindings): Array<{ pid: number; parentPid: number; exeName: string }> | null {
  const snapshot = bindings.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  if (snapshot === 0n || snapshot === 0xffffffffffffffffn || snapshot === 0xffffffffn) return null
  try {
    const is32 = process.arch === 'ia32'
    const entrySize = is32 ? 556 : 568
    const parentOffset = is32 ? 24 : 32
    const exeOffset = is32 ? 36 : 44
    const entry = Buffer.alloc(entrySize)
    entry.writeUInt32LE(entrySize, 0)
    if (!bindings.Process32FirstW(snapshot, entry)) return null
    const items: Array<{ pid: number; parentPid: number; exeName: string }> = []
    let guard = 0
    do {
      if (++guard > 16384) return null
      const pid = entry.readUInt32LE(8)
      const parentPid = entry.readUInt32LE(parentOffset)
      const rawExe = entry.subarray(exeOffset, exeOffset + 520)
      let end = 0
      while (end + 1 < rawExe.length && (rawExe[end] !== 0 || rawExe[end + 1] !== 0)) end += 2
      const exeName = rawExe.subarray(0, end).toString('utf16le')
      items.push({ pid, parentPid, exeName })
      entry.writeUInt32LE(entrySize, 0)
    } while (bindings.Process32NextW(snapshot, entry))
    return items
  } finally {
    bindings.CloseHandlePtr(snapshot)
  }
}

function sameOwnerNative(a: ProcessOwner, b: ProcessOwner): boolean {
  if (a.pid !== b.pid || a.userId !== b.userId) return false
  try {
    if (BigInt(a.startedAt) / 10n !== BigInt(b.startedAt) / 10n) return false
  } catch { return false }
  if (a.executable.toLowerCase() === b.executable.toLowerCase()) return true
  const ca = canonicalWinPath(a.executable)
  const cb = canonicalWinPath(b.executable)
  return Boolean(ca && cb && ca.toLowerCase() === cb.toLowerCase())
}

/**
 * 进程内直接执行 windows-lifecycle.ps1 -Mode inspect 等价查询（<2ms 替代 ~350ms PowerShell）。
 * 任何权限异常或边界不确定情况返回 undefined，自动回退至原 PowerShell 脚本裁决。
 */
export function fastInspectProcess(input: {
  root: ProcessOwner
  children?: boolean
  recovering?: boolean
}): {
  root: { owner: ProcessOwner; argv: string[] } | null
  children: Array<{ owner: ProcessOwner; argv: string[] }>
  bootStartedAt: string
} | undefined {
  const bindings = loadBindings()
  if (!bindings) return undefined
  try {
    const self = fastProcessIdentity(process.pid)
    if (!self || input.root.pid <= 0 || input.root.userId !== self.userId) return undefined
    const bootStartedAt = fastKernelBootTicks()
    if (!bootStartedAt) return undefined
    const expectedTicks = BigInt(input.root.startedAt)
    if (expectedTicks > 0n && expectedTicks < BigInt(bootStartedAt)) {
      return { root: null, children: [], bootStartedAt }
    }
    const handle = bindings.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, input.root.pid)
    if (isNullPtr(handle)) {
      const err = bindings.GetLastError()
      if (err === ERROR_INVALID_PARAMETER || err === ERROR_NOT_FOUND) {
        return { root: null, children: [], bootStartedAt }
      }
      return undefined
    }
    let rootDetails: { owner: ProcessOwner; argv: string[] } | null = null
    try {
      const created = Buffer.alloc(8)
      const exited = Buffer.alloc(8)
      const kernel = Buffer.alloc(8)
      const user = Buffer.alloc(8)
      if (!bindings.GetProcessTimes(handle, created, exited, kernel, user)) return undefined
      const actualBirth = (created.readBigUInt64LE(0) + FILETIME_TO_DOTNET_TICKS) / 10n
      if (actualBirth !== expectedTicks / 10n) {
        return input.recovering ? { root: null, children: [], bootStartedAt } : undefined
      }
      if (bindings.WaitForSingleObject(handle, 0) === WAIT_OBJECT_0) {
        return { root: null, children: [], bootStartedAt }
      }
      const actualOwner = readProcessOwnerFromHandle(bindings, handle, input.root.pid)
      if (!actualOwner || !sameOwnerNative(input.root, actualOwner)) return undefined
      const argv = readProcessArgvFromHandle(bindings, handle)
      if (!argv) return undefined
      rootDetails = { owner: actualOwner, argv }
    } finally {
      bindings.CloseHandle(handle)
    }

    const childDetails: Array<{ owner: ProcessOwner; argv: string[] }> = []
    if (rootDetails && input.children !== false) {
      const snap = enumerateProcessSnapshot(bindings)
      if (!snap) return undefined
      for (const item of snap) {
        if (item.parentPid !== input.root.pid || item.pid <= 0) continue
        const ch = bindings.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, item.pid)
        if (isNullPtr(ch)) continue
        try {
          if (bindings.WaitForSingleObject(ch, 0) === WAIT_OBJECT_0) continue
          const childOwner = readProcessOwnerFromHandle(bindings, ch, item.pid)
          if (!childOwner) continue
          const childArgv = readProcessArgvFromHandle(bindings, ch)
          if (!childArgv) return undefined
          childDetails.push({ owner: childOwner, argv: childArgv })
        } finally {
          bindings.CloseHandle(ch)
        }
      }
    }
    return { root: rootDetails, children: childDetails, bootStartedAt }
  } catch {
    return undefined
  }
}

/**
 * 进程内快速执行 windows-lifecycle.ps1 -Mode discover-gui（<5ms 替代 ~1,500ms 全系统扫描）。
 * 先按可执行文件名过滤再做完整物理路径、SID 与参数校验；若遇到相对入口或歧义情况返回 undefined 回退原脚本。
 */
export function fastDiscoverGui(spec: {
  executables: string[]
  appPath: string | null
  excludePid: number
  excludeOwner?: ProcessOwner
  userId: string
  userData: string
  guiOwner?: ProcessOwner
  daemonOwner?: ProcessOwner
  allowDefaultProfile: boolean
}): { candidates: Array<{ owner: ProcessOwner; argv: string[] }> } | undefined {
  const bindings = loadBindings()
  if (!bindings) return undefined
  try {
    const self = fastProcessIdentity(process.pid)
    if (!self || self.userId !== spec.userId) return undefined
    if (spec.executables.length < 1 || spec.executables.length > 3) return undefined
    const canonicalUserData = canonicalWinPath(spec.userData)
    if (!canonicalUserData) return undefined
    const canonicalAppPath = spec.appPath ? canonicalWinPath(spec.appPath) : null
    if (spec.appPath && !canonicalAppPath) return undefined

    // 若存在存活的 daemonOwner，复核其命令行归属；若有任何异常交回原脚本处理
    if (spec.daemonOwner) {
      const boot = fastKernelBootTicks()
      if (!boot) return undefined
      const historical = BigInt(spec.daemonOwner.startedAt) > 0n && BigInt(spec.daemonOwner.startedAt) < BigInt(boot)
      if (!historical) {
        const inspectedDaemon = fastInspectProcess({ root: spec.daemonOwner, children: false })
        if (inspectedDaemon === undefined) return undefined
        if (inspectedDaemon.root) {
          let tail = inspectedDaemon.root.argv.slice(1)
          if (canonicalAppPath) {
            if (tail.length !== 3 || !isAbsolute(tail[0])) return undefined
            const daemonApp = canonicalWinPath(tail[0])
            if (!daemonApp || daemonApp.toLowerCase() !== canonicalAppPath.toLowerCase()) return undefined
            tail = tail.slice(1)
          }
          if (tail.length !== 2 || tail[0] !== '--trellis-role=daemon' || !/^--trellis-user-data-base64=[A-Za-z0-9+/=]+$/.test(tail[1])) {
            return undefined
          }
          const decodedProfile = Buffer.from(tail[1].slice('--trellis-user-data-base64='.length), 'base64').toString('utf8')
          const daemonProfile = canonicalWinPath(decodedProfile)
          if (!daemonProfile || daemonProfile.toLowerCase() !== canonicalUserData.toLowerCase()) return undefined
        }
      }
    }

    const targetCanonicals = new Set<string>()
    const targetExeNames = new Set<string>()
    for (const exe of spec.executables) {
      const c = canonicalWinPath(exe)
      if (!c) return undefined
      targetCanonicals.add(c.toLowerCase())
      targetExeNames.add(basename(c).toLowerCase())
      targetExeNames.add(basename(exe).toLowerCase())
    }

    const snap = enumerateProcessSnapshot(bindings)
    if (!snap) return undefined
    const candidates: Array<{ owner: ProcessOwner; argv: string[] }> = []
    for (const item of snap) {
      if (item.pid <= 0 || item.pid === spec.excludePid) continue
      // 先按进程短文件名快速排除 99% 无关系统进程，避免无谓 OpenProcess 与磁盘句柄查询
      if (!targetExeNames.has(item.exeName.toLowerCase())) continue
      const h = bindings.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, item.pid)
      if (isNullPtr(h)) continue
      try {
        if (bindings.WaitForSingleObject(h, 0) === WAIT_OBJECT_0) continue
        const owner = readProcessOwnerFromHandle(bindings, h, item.pid)
        if (!owner || owner.userId !== spec.userId) continue
        const physicalExe = canonicalWinPath(owner.executable)
        if (!physicalExe || !targetCanonicals.has(physicalExe.toLowerCase())) continue
        if (spec.excludeOwner && sameOwnerNative(spec.excludeOwner, owner)) continue
        const argv = readProcessArgvFromHandle(bindings, h)
        if (!argv) return undefined
        // 跳过 Chromium 子进程（renderer/gpu/utility 等），快速放行
        if (argv.some(arg => arg.startsWith('--type='))) continue
        let tail = argv.slice(1)
        if (canonicalAppPath) {
          if (tail.length === 0) continue
          if (isAbsolute(tail[0])) {
            const argApp = canonicalWinPath(tail[0])
            if (!argApp || argApp.toLowerCase() !== canonicalAppPath.toLowerCase()) continue
          } else {
            // 相对入口需要遍历子渲染进程核对 --app-path，交回完整脚本处理
            if (['.', './', '.\\', 'out/main/index.js'].includes(tail[0])) return undefined
            continue
          }
          tail = tail.slice(1)
        }
        const roles = tail.filter(a => a.startsWith('--trellis-role='))
        const profiles = tail.filter(a => a.startsWith('--trellis-user-data-base64='))
        const other = tail.filter(a =>
          !a.startsWith('--trellis-role=')
          && !a.startsWith('--trellis-user-data-base64=')
          && !/^--trellis-gui-contained=[a-f0-9-]{36}$/.test(a)
          && !/^--(remote-debugging-port|inspect|inspect-brk)=\d+$/.test(a)
          && a !== '--no-sandbox'
        )
        if (roles.length > 1 || (roles.length === 1 && roles[0] !== '--trellis-role=gui') || profiles.length > 1 || other.length !== 0) {
          continue
        }
        if (profiles.length === 1) {
          const decoded = Buffer.from(profiles[0].slice('--trellis-user-data-base64='.length), 'base64').toString('utf8')
          const candProfile = canonicalWinPath(decoded)
          if (!candProfile || candProfile.toLowerCase() !== canonicalUserData.toLowerCase()) continue
        } else if (!spec.allowDefaultProfile) {
          return undefined
        }
        candidates.push({ owner, argv })
      } finally {
        bindings.CloseHandle(h)
      }
    }
    return { candidates }
  } catch {
    return undefined
  }
}

export interface FastContainedControllerInput {
  readonly root: ProcessOwner
  readonly jobName: string
  readonly helpers: readonly ProcessOwner[]
  readonly recovering?: boolean
}

export interface FastContainedController {
  readonly exitedBeforeBoot?: true
  arm(graceMs: number, timeoutMs: number): Promise<void>
  disarm(): Promise<void>
  terminate(timeoutMs: number): Promise<void>
  verify(timeoutMs: number): Promise<void>
  dispose(): Promise<void>
}

function captureOriginalHandle(
  bindings: Win32Bindings,
  expected: ProcessOwner,
  expectedUserId: string,
  recovering: boolean
): { handle: unknown | null } | undefined {
  if (expected.pid <= 0 || expected.userId !== expectedUserId) return undefined
  const handle = bindings.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, false, expected.pid)
  if (isNullPtr(handle)) {
    const err = bindings.GetLastError()
    if (err === ERROR_INVALID_PARAMETER || err === ERROR_NOT_FOUND) return { handle: null }
    return undefined
  }
  try {
    const created = Buffer.alloc(8)
    const exited = Buffer.alloc(8)
    const kernel = Buffer.alloc(8)
    const user = Buffer.alloc(8)
    if (!bindings.GetProcessTimes(handle, created, exited, kernel, user)) {
      bindings.CloseHandle(handle)
      return undefined
    }
    const actualBirth = (created.readBigUInt64LE(0) + FILETIME_TO_DOTNET_TICKS) / 10n
    const expectedBirth = BigInt(expected.startedAt) / 10n
    if (actualBirth !== expectedBirth) {
      bindings.CloseHandle(handle)
      return recovering ? { handle: null } : undefined
    }
    if (bindings.WaitForSingleObject(handle, 0) === WAIT_OBJECT_0) {
      return { handle }
    }
    const actual = readProcessOwnerFromHandle(bindings, handle, expected.pid)
    if (!actual || !sameOwnerNative(expected, actual)) {
      bindings.CloseHandle(handle)
      return undefined
    }
    return { handle }
  } catch {
    bindings.CloseHandle(handle)
    return undefined
  }
}

/**
 * 进程内原生受管 Job 控制器（严格等价于 windows-lifecycle.ps1 -Mode controller 的 contained=true 路径）：
 * - 在用户确认前打开并持有 root、named Job 与 guardian 内核句柄，防止 PID 复用；
 * - 核验 root 仍在受管 Job 内，提供看门狗 arm/disarm、terminate、verify 与 dispose；
 * - 消除每次退出与开发重启时拉起 powershell.exe -Mode controller 的 ~650-1450ms 开销；
 * - 任何非标准场景或 Win32 异常返回 undefined，无缝回退原 PowerShell 控制器。
 */
export function fastContainedController(input: FastContainedControllerInput): FastContainedController | undefined {
  const bindings = loadBindings()
  if (!bindings) return undefined
  const self = fastProcessIdentity(process.pid)
  if (!self || input.root.pid <= 0 || input.root.userId !== self.userId) return undefined

  const boot = fastKernelBootTicks()
  if (!boot) return undefined
  if (BigInt(input.root.startedAt) > 0n && BigInt(input.root.startedAt) < BigInt(boot)) {
    return {
      exitedBeforeBoot: true,
      arm: async () => undefined,
      disarm: async () => undefined,
      terminate: async () => undefined,
      verify: async () => undefined,
      dispose: async () => undefined
    }
  }

  const recovering = input.recovering === true
  let rootHandle: unknown | null = null
  let jobHandle: unknown | null = null
  const helperHandles: unknown[] = []
  const closeAll = (): void => {
    if (rootHandle) { bindings.CloseHandle(rootHandle); rootHandle = null }
    if (jobHandle) { bindings.CloseHandle(jobHandle); jobHandle = null }
    while (helperHandles.length > 0) {
      const h = helperHandles.pop()
      if (h) bindings.CloseHandle(h)
    }
  }

  try {
    const capturedRoot = captureOriginalHandle(bindings, input.root, self.userId, recovering)
    if (!capturedRoot) return undefined
    rootHandle = capturedRoot.handle

    const openedJob = bindings.OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, input.jobName)
    if (isNullPtr(openedJob)) {
      if (bindings.GetLastError() !== ERROR_FILE_NOT_FOUND) { closeAll(); return undefined }
      jobHandle = null
    } else {
      jobHandle = openedJob
    }

    if (rootHandle && bindings.WaitForSingleObject(rootHandle, 0) !== WAIT_OBJECT_0) {
      if (!jobHandle) { closeAll(); return undefined }
      const memberOut = new Int32Array([0])
      if (!bindings.IsProcessInJob(rootHandle, jobHandle, memberOut) || memberOut[0] === 0) {
        closeAll()
        return undefined
      }
    }

    for (const helper of input.helpers) {
      const capturedHelper = captureOriginalHandle(bindings, helper, self.userId, recovering)
      if (!capturedHelper) { closeAll(); return undefined }
      if (capturedHelper.handle) helperHandles.push(capturedHelper.handle)
    }

    const accounting = Buffer.alloc(48)
    let disposed = false
    let watchdog: ReturnType<typeof setTimeout> | null = null
    let armedAt = -1
    const clearWatchdog = (): void => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null }
      armedAt = -1
    }
    const isHandleExited = (h: unknown): boolean => {
      const state = bindings.WaitForSingleObject(h, 0)
      if (state === WAIT_OBJECT_0) return true
      if (state === 258) return false
      throw new Error('native-failure')
    }
    const isJobEmpty = (): boolean => {
      if (!jobHandle) return true
      if (!bindings.QueryInformationJobObject(jobHandle, 1, accounting, 48, null)) throw new Error('native-failure')
      return accounting.readUInt32LE(40) === 0
    }
    const checkExited = (): { exited: boolean; reason?: string } => {
      if (rootHandle && !isHandleExited(rootHandle)) return { exited: false, reason: 'root-alive' }
      if (!isJobEmpty()) return { exited: false, reason: 'job-not-empty' }
      for (const h of helperHandles) {
        if (!isHandleExited(h)) return { exited: false, reason: 'helper-alive' }
      }
      return { exited: true }
    }
    const terminateScope = (): void => {
      if (disposed) return
      if (jobHandle && !isJobEmpty()) bindings.TerminateJobObject(jobHandle, 71)
      for (const h of helperHandles) {
        if (!isHandleExited(h)) bindings.TerminateProcess(h, 71)
      }
    }
    const waitExited = async (terminateFirst: boolean, timeoutMs: number): Promise<void> => {
      if (disposed) throw new Error('The captured native controller is no longer available.')
      if (terminateFirst) {
        clearWatchdog()
        terminateScope()
      }
      const deadline = Date.now() + timeoutMs
      while (true) {
        const state = checkExited()
        if (state.exited) return
        if (!terminateFirst && armedAt >= 0 && Date.now() >= armedAt) {
          clearWatchdog()
          terminateScope()
        }
        if (Date.now() >= deadline) {
          throw new Error(state.reason ?? 'exit-deadline')
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }

    return {
      async arm(graceMs: number): Promise<void> {
        if (disposed) throw new Error('The captured native controller is no longer available.')
        if (armedAt >= 0) return
        armedAt = Date.now() + graceMs
        watchdog = setTimeout(() => {
          watchdog = null
          armedAt = -1
          try { terminateScope() } catch { /* 核验阶段将如实上报未退出状态 */ }
        }, graceMs)
        watchdog.unref()
      },
      async disarm(): Promise<void> {
        if (disposed) return
        clearWatchdog()
      },
      async terminate(timeoutMs: number): Promise<void> {
        await waitExited(true, timeoutMs)
      },
      async verify(timeoutMs: number): Promise<void> {
        await waitExited(false, timeoutMs)
      },
      async dispose(): Promise<void> {
        if (disposed) return
        disposed = true
        clearWatchdog()
        closeAll()
      }
    }
  } catch {
    closeAll()
    return undefined
  }
}
