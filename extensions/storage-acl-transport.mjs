// Private per-OMP transport. Every request runs the unchanged native ACL checks.
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dlopen, ptr } from 'bun:ffi'

export function createWindowsAclTransport(helperPath, timeoutMs = 60000) {
  let worker
  let library
  const sleep = new Int32Array(new SharedArrayBuffer(4))
  function api() {
    library ??= dlopen('kernel32.dll', {
      CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'ptr'], returns: 'ptr' },
      WaitNamedPipeW: { args: ['ptr', 'u32'], returns: 'bool' },
      SetNamedPipeHandleState: { args: ['ptr', 'ptr', 'ptr', 'ptr'], returns: 'bool' },
      GetNamedPipeServerProcessId: { args: ['ptr', 'ptr'], returns: 'bool' },
      WriteFile: { args: ['ptr', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
      ReadFile: { args: ['ptr', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
      GetLastError: { args: [], returns: 'u32' },
      CloseHandle: { args: ['ptr'], returns: 'bool' },
    })
    return library.symbols
  }
  function warm() {
    if (worker && !worker.failed) return worker
    const name = `omp-oms-${process.pid}-${randomUUID()}`
    const child = spawn(helperPath, [name, String(process.pid)], { stdio: 'ignore', windowsHide: true })
    const current = { child, name: Buffer.from(`\\\\.\\pipe\\${name}\0`, 'utf16le'), failed: false }
    worker = current
    child.on('error', () => { current.failed = true })
    child.on('exit', () => { current.failed = true })
    child.unref()
    return current
  }
  function stop() {
    const previous = worker
    worker = undefined
    previous?.child.kill()
  }
  function request(payload) {
    const native = api()
    const current = warm()
    const deadline = performance.now() + timeoutMs
    let handle
    try {
      const connectDeadline = Math.min(deadline, performance.now() + 5000)
      while (performance.now() < connectDeadline && !current.failed) {
        native.WaitNamedPipeW(ptr(current.name), 20)
        handle = native.CreateFileW(ptr(current.name), 0xc0000000, 0, null, 3, 0, null)
        if (handle && handle !== -1 && handle !== 0xffffffffffffffff && handle !== 0xffffffffffffffffn) break
        handle = undefined
        Atomics.wait(sleep, 0, 0, 1)
      }
      if (!handle) throw new Error('ACL worker connection failed')
      const serverPid = new Uint32Array(1)
      const identityOk = native.GetNamedPipeServerProcessId(handle, ptr(serverPid))
      if (!identityOk || serverPid[0] !== current.child.pid) {
        throw new Error('ACL worker identity mismatch')
      }
      // Message mode plus nonblocking I/O allows a bounded synchronous exchange.
      const mode = new Uint32Array([3])
      if (!native.SetNamedPipeHandleState(handle, ptr(mode), null, null)) throw new Error('ACL pipe setup failed')
      const input = Buffer.from(JSON.stringify(payload) + '\n', 'utf8')
      if (input.length > 65536) throw new Error('ACL request exceeds limit')
      const count = new Uint32Array(1)
      if (!native.WriteFile(handle, ptr(input), input.length, ptr(count), null) || count[0] !== input.length) {
        throw new Error('ACL worker write failed')
      }
      const buffer = Buffer.allocUnsafe(65536)
      const chunks = []
      let total = 0
      while (performance.now() < deadline) {
        count[0] = 0
        const complete = native.ReadFile(handle, ptr(buffer), buffer.length, ptr(count), null)
        const error = complete ? 0 : native.GetLastError()
        if (count[0]) {
          total += count[0]
          if (total > 32 * 1024 * 1024) throw new Error('ACL reply exceeds limit')
          chunks.push(Buffer.from(buffer.subarray(0, count[0])))
        }
        if (complete) return JSON.parse(Buffer.concat(chunks, total).toString('utf8'))
        if (error !== 232 && error !== 234 && error !== 536) throw new Error('ACL worker read failed')
        if (!count[0]) Atomics.wait(sleep, 0, 0, 1)
      }
      throw new Error('ACL worker timed out')
    } catch (error) {
      stop()
      throw error
    } finally {
      if (handle) native.CloseHandle(handle)
    }
  }
  return { warm, request, stop }
}
