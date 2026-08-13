import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { effectCode, expectedState, renderFixture } from './cases.mjs'

const MAX_BODY_BYTES = 1_024

export function createFixtureServer(sealedPairs) {
  const runs = new Map()
  for (const pair of sealedPairs) {
    for (const [arm, runId] of Object.entries(pair.runIds)) {
      if (runs.has(runId)) throw new Error(`duplicate fixture run id ${runId}`)
      runs.set(runId, {
        pairId: pair.pairId,
        arm,
        caseId: pair.caseId,
        variant: pair.variant,
        expectedTruth: pair.expectedTruth,
        state: null,
        actionCount: 0,
      })
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const runMatch = url.pathname.match(/^\/run\/([a-f0-9]{24})$/)
    if (request.method === 'GET' && runMatch) {
      const run = runs.get(runMatch[1])
      if (!run) return respond(response, 404, 'text/plain; charset=utf-8', 'unknown run')
      response.setHeader('cache-control', 'no-store')
      response.setHeader('content-security-policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'; frame-src 'none'")
      response.setHeader('referrer-policy', 'no-referrer')
      return respond(response, 200, 'text/html; charset=utf-8', renderFixture(run.caseId))
    }

    const effectMatch = url.pathname.match(/^\/effect\/([a-f0-9]{24})$/)
    if (request.method === 'POST' && effectMatch) {
      const run = runs.get(effectMatch[1])
      if (!run) return respond(response, 404, 'application/json', '{"error":"unknown run"}')
      let body = ''
      request.setEncoding('utf8')
      for await (const chunk of request) {
        body += chunk
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) return respond(response, 413, 'application/json', '{"error":"too large"}')
      }
      if (body !== '{}') return respond(response, 400, 'application/json', '{"error":"invalid action"}')
      if (run.actionCount !== 0) return respond(response, 409, 'application/json', '{"error":"duplicate action"}')
      run.actionCount++
      run.state = expectedState(run.caseId, run.variant)
      // Fixed server delay and response schema for every case/variant. The numeric code
      // chooses one of two branches in identical fixture bytes; it carries no truth label.
      await delay(25)
      return respond(response, 200, 'application/json', JSON.stringify({ code: effectCode(run.caseId, run.variant) }))
    }

    return respond(response, 404, 'text/plain; charset=utf-8', 'not found')
  })

  return {
    server,
    runs,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('fixture did not publish a loopback port')
      if (address.port === 8377) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        throw new Error('fixture selected forbidden shared port 8377 and was closed')
      }
      return address.port
    },
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
    run(runId) {
      const value = runs.get(runId)
      if (!value) throw new Error(`unknown fixture run ${runId}`)
      return value
    },
  }
}

function respond(response, status, contentType, body) {
  response.statusCode = status
  response.setHeader('content-type', contentType)
  response.setHeader('x-content-type-options', 'nosniff')
  response.end(body)
}
