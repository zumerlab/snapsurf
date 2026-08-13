/**
 * Run a test command with an owned daemon port, token file and log directory.
 *
 * Product gates must never attach to, mutate, or stop the developer's live daemon.
 * The child inherits this isolated runtime, and the wrapper fails if it leaves its
 * daemon listening after exit.
 */
import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('usage: node tools/run-isolated.mjs <command> [args...]')
  process.exitCode = 2
} else {
  const runtime = await mkdtemp(join(tmpdir(), 'snapdom-agent-gate-'))
  const reserve = createServer()
  await new Promise((resolve, reject) => {
    reserve.once('error', reject)
    reserve.listen(0, '127.0.0.1', resolve)
  })
  const address = reserve.address()
  if (!address || typeof address === 'string') throw new Error('failed to reserve isolated daemon port')
  const port = address.port
  await new Promise((resolve) => reserve.close(resolve))
  if (port === 8377) throw new Error('isolated test runner selected the shared development port')

  const env = {
    ...process.env,
    SNAPDOM_AGENT_PORT: String(port),
    SNAPDOM_AGENT_TOKEN_FILE: join(runtime, 'daemon.token'),
    SNAPDOM_AGENT_LOGDIR: join(runtime, 'logs'),
  }
  delete env.SNAPDOM_AGENT_TOKEN
  const child = spawn(command, args, { cwd: process.cwd(), env, stdio: 'inherit' })
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

  const portOpen = () => new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (open) => { socket.destroy(); resolve(open) }
    socket.setTimeout(150, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })

  // Normal MCP/CLI teardown is asynchronous for a few ticks. Give it a bounded
  // opportunity to finish before classifying the process as leaked.
  for (let i = 0; i < 20 && await portOpen(); i++) await delay(50)
  const leaked = await portOpen()
  let cleanupError = null
  if (leaked) {
    try {
      process.env.SNAPDOM_AGENT_PORT = env.SNAPDOM_AGENT_PORT
      process.env.SNAPDOM_AGENT_TOKEN_FILE = env.SNAPDOM_AGENT_TOKEN_FILE
      process.env.SNAPDOM_AGENT_LOGDIR = env.SNAPDOM_AGENT_LOGDIR
      const { daemonFetch } = await import(`./daemon-client.mjs?gate=${Date.now()}`)
      await daemonFetch({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmd: 'stop', args: [], envelope: true }),
      }, port)
      for (let i = 0; i < 40 && await portOpen(); i++) await delay(50)
      if (await portOpen()) cleanupError = `daemon on isolated port ${port} ignored authenticated stop`
    } catch (error) {
      cleanupError = `could not clean isolated daemon on port ${port}: ${error.message || error}`
    }
  }
  if (!cleanupError) await rm(runtime, { recursive: true, force: true })

  if (cleanupError) console.error(`${cleanupError}; recovery token retained in ${runtime}`)
  if (leaked) console.error(`test command leaked a daemon on owned port ${port}`)
  if (outcome.signal) console.error(`test command terminated by ${outcome.signal}`)
  process.exitCode = outcome.code === 0 && !leaked && !cleanupError ? 0 : (outcome.code || 1)
}
