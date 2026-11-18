import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonLines } from '../providers/process.js';
const SCRIPT = String.raw`
param([int]$WorkerPid)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
public static class RelayJobGuard {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a,b; public uint flags; public UIntPtr min,max; public uint limit; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED { public BASIC basic; public IO io; public UIntPtr a,b,c,d; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr data,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr data,uint length,out uint returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static IntPtr job, ownerHandle;
  public static void Limits(bool kill) {
    EXTENDED v=new EXTENDED();v.basic.flags=kill?0x2000u:0u;
    int n=Marshal.SizeOf(typeof(EXTENDED));IntPtr p=Marshal.AllocHGlobal(n);
    try { Marshal.StructureToPtr(v,p,false);if(!SetInformationJobObject(job,9,p,(uint)n))throw new Win32Exception(); } finally { Marshal.FreeHGlobal(p); }
  }
  public static void Prepare(int owner) {
    job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception();
    Limits(true);
    ownerHandle=OpenProcess(0x101u,false,owner);if(ownerHandle==IntPtr.Zero)throw new Win32Exception();
  }
  public static void Assign() {
    try { if(!AssignProcessToJobObject(job,ownerHandle))throw new Win32Exception(); } finally { CloseHandle(ownerHandle);ownerHandle=IntPtr.Zero; }
  }
  public static int[] Members() {
    int n=8+IntPtr.Size*8192;IntPtr p=Marshal.AllocHGlobal(n);
    try { uint size;if(!QueryInformationJobObject(job,3,p,(uint)n,out size))throw new Win32Exception();
      int count=Marshal.ReadInt32(p,4);if(count<0||count>8192)throw new Exception("Job process limit exceeded");
      int[] ids=new int[count];for(int i=0;i<count;i++)ids[i]=checked((int)Marshal.ReadIntPtr(p,8+i*IntPtr.Size).ToInt64());return ids;
    } finally { Marshal.FreeHGlobal(p); }
  }
  public static int[] Drain(int owner) {
    HashSet<int> seen=new HashSet<int>();
    for(int round=0;round<100;round++) {
      int remaining=0;
      foreach(int id in Members())if(id!=owner) {
        seen.Add(id);remaining++;
        IntPtr p=OpenProcess(0x1001u,false,id);if(p==IntPtr.Zero)continue;
        try { bool inside;if(!IsProcessInJob(p,job,out inside))throw new Win32Exception();if(inside&&!TerminateProcess(p,137)&&Marshal.GetLastWin32Error()!=5)throw new Win32Exception(); } finally { CloseHandle(p); }
      }
      if(remaining==0){int[] result=new int[seen.Count];seen.CopyTo(result);return result;}Thread.Sleep(30);
    }
    throw new Exception("Owned job descendants did not stop");
  }
  public static void Release(int owner) { foreach(int id in Members())if(id!=owner)throw new Exception("Owned descendants remain");Limits(false);CloseHandle(job);job=IntPtr.Zero; }
}
'@
try {
  [RelayJobGuard]::Prepare($WorkerPid)
  [Console]::Out.WriteLine('{"type":"challenge"}');[Console]::Out.Flush()
  if ([Console]::ReadLine() -ne 'confirm-owner') { throw 'Owner did not confirm its retained process handle' }
  [RelayJobGuard]::Assign()
  [Console]::Out.WriteLine('{"type":"ready"}');[Console]::Out.Flush()
  while ($null -ne ($line = [Console]::ReadLine())) {
    if ($line -eq 'drain') {
      $pids = @([RelayJobGuard]::Drain($WorkerPid))
      [Console]::Out.WriteLine((@{type='drained';pids=$pids} | ConvertTo-Json -Compress));[Console]::Out.Flush()
    } elseif ($line -eq 'release') {
      [RelayJobGuard]::Release($WorkerPid)
      [Console]::Out.WriteLine('{"type":"released"}');[Console]::Out.Flush()
      exit 0
    } else { throw 'Invalid guard command' }
  }
} catch { [Console]::Out.WriteLine('{"type":"failed"}');[Console]::Out.Flush();exit 1 }
`;
export class WindowsTreeGuard {
  private pending?: { done: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private closed = false;
  private constructor(readonly child: ChildProcessWithoutNullStreams) {
    const parser = new JsonLines(value => { const p = this.pending; if (!p) return; this.pending = undefined; clearTimeout(p.timer); value.type === 'failed' ? p.reject(Error('Windows job process proof failed')) : p.done(value); });
    child.stdout.on('data', chunk => { try { parser.push(chunk); } catch { this.fail(); } });
    child.stderr.resume(); child.once('error', () => this.fail()); child.once('close', () => { this.closed = true; this.fail(); });
  }
  private fail() { if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(Error('Windows job guard exited without proof')); this.pending = undefined; } }
  private next(command?: string): Promise<any> {
    if (this.pending || this.closed) return Promise.reject(Error('Windows job guard is unavailable'));
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { this.pending = undefined; reject(Error('Windows job guard timed out')); }, 12_000);
      this.pending = { done, reject, timer }; if (command) this.child.stdin.write(command + '\n');
    });
  }
  static async create(directory: string, track: (child: ChildProcessWithoutNullStreams) => void): Promise<WindowsTreeGuard> {
    if (process.platform !== 'win32') throw Error('Owned process-tree proof requires the verified Windows job guard');
    const path = join(directory, 'tree-guard.ps1'); await writeFile(path, SCRIPT);
    const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-File',path,String(process.pid)], { windowsHide: true, stdio: 'pipe' });
    track(child); const guard = new WindowsTreeGuard(child);
    const challenge = await guard.next(); if (challenge.type !== 'challenge') throw Error('Windows job guard did not request owner confirmation');
    const ready = await guard.next('confirm-owner'); if (ready.type !== 'ready') throw Error('Windows job guard did not initialize'); return guard;
  }
  async drain(): Promise<number[]> {
    const response = await this.next('drain');
    if (response.type !== 'drained' || !Array.isArray(response.pids) || response.pids.some((pid: unknown) => !Number.isSafeInteger(pid) || Number(pid) <= 0)) throw Error('Invalid Windows job membership proof');
    return response.pids;
  }
  async release(): Promise<void> {
    const result = await this.next('release'); if (result.type !== 'released') throw Error('Windows job guard did not release');
    this.child.stdin.end();
    if (!this.closed) await new Promise<void>((done, reject) => { const timer = setTimeout(() => reject(Error('Windows job guard did not exit')), 2000); this.child.once('close', () => { clearTimeout(timer); done(); }); });
  }
}
