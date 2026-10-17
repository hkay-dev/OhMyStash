// Test-only subprocesses for pipe client identity and parent-exit cleanup.
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createWindowsAclTransport } from '../extensions/storage-acl-transport.mjs'

if (process.argv[2] === 'foreign-client') {
  const socket = createConnection(process.argv[3])
  const rejected = await new Promise((resolve, reject) => {
    let received = false
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Foreign client did not close')) }, 2000)
    socket.on('connect', () => socket.write('{}\n'))
    socket.on('data', () => { received = true })
    socket.on('error', () => {})
    socket.on('close', () => { clearTimeout(timer); resolve(!received) })
  })
  assert(rejected, 'Foreign client must not receive an ACL reply')
  console.log('foreign-client-rejected')
} else if (process.argv[2] === 'orphan-parent') {
  const worker = createWindowsAclTransport(fileURLToPath(new URL('../extensions/storage-acl-worker.exe', import.meta.url)))
  assert.deepEqual(worker.request({ action: 'invalid', path: process.argv[3] }), { ok: false, records: [] })
  console.log(JSON.stringify({ workerPid: worker.warm().child.pid }))
} else {
  throw new Error('Pass a supported fixture action')
}
