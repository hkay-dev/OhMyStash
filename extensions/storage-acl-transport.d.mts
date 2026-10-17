import type { ChildProcess } from "node:child_process";

export interface WindowsAclWorker {
  child: ChildProcess;
  name: Buffer;
  failed: boolean;
}

export interface WindowsAclTransport {
  warm(): WindowsAclWorker;
  request(payload: unknown): unknown;
  stop(): void;
}

export function createWindowsAclTransport(helperPath: string, timeoutMs?: number): WindowsAclTransport;
