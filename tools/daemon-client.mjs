import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_PORT = Number.parseInt(process.env.SNAPDOM_AGENT_PORT || '8377', 10)

export const daemonTokenFile = (port = DEFAULT_PORT) => {
  if (process.env.SNAPDOM_AGENT_TOKEN_FILE) return process.env.SNAPDOM_AGENT_TOKEN_FILE
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return join(tmpdir(), `snapdom-agent-${uid}-${port}.token`)
}

export const daemonToken = async (port = DEFAULT_PORT) => {
  const token = process.env.SNAPDOM_AGENT_TOKEN || (await readFile(daemonTokenFile(port), 'utf8')).trim()
  if (!token) throw new Error('snapdom-agent daemon token is empty')
  return token
}

const hmac = (token, prefix, payload) => createHmac('sha256', token).update(prefix).update(payload).digest('hex')

const sameMac = (actual, expected) => {
  if (!/^[a-f\d]{64}$/i.test(actual || '')) return false
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

/** POST an authenticated command and reject responses not signed by the daemon. */
export const daemonFetch = async (init = {}, port = DEFAULT_PORT) => {
  const token = await daemonToken(port)
  const authNonce = randomBytes(16).toString('hex')
  const authResponse = await fetch(`http://127.0.0.1:${port}/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: authNonce }),
    signal: init.signal,
  })
  const authExpected = hmac(token, `auth-v1\n${authNonce}`, '')
  if (!authResponse.ok || !sameMac(authResponse.headers.get('x-snapdom-auth'), authExpected)) {
    throw new Error('snapdom-agent daemon authentication preflight failed')
  }

  const requestNonce = randomBytes(16).toString('hex')
  const headers = new Headers(init.headers)
  headers.delete('authorization')

  const request = new Request(`http://127.0.0.1:${port}/cmd`, { ...init, method: 'POST', headers })
  const body = Buffer.from(await request.clone().arrayBuffer())
  request.headers.set('x-snapdom-nonce', requestNonce)
  request.headers.set('x-snapdom-auth', hmac(token, `request-v1\n${requestNonce}\n`, body))

  const response = await fetch(request)
  const responseText = await response.clone().text()
  const expected = hmac(token, `response-v1\n${requestNonce}\n`, responseText)
  if (!sameMac(response.headers.get('x-snapdom-auth'), expected)) {
    throw new Error('snapdom-agent daemon response authentication failed')
  }
  return response
}
