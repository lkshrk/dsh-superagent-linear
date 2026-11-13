import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { Waker, handleWebhook } from '../src/webhook.ts'

const SECRET = 'lin_wh_test'
const NOW = Date.parse('2026-11-13T15:00:00.000Z')
const dir = mkdtempSync(join(tmpdir(), 'linear-webhook-'))
const secretFile = join(dir, 'secret')
writeFileSync(secretFile, `${SECRET}\n`)

function request(method: string, body: string | Buffer, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(req, { method, headers })
  return req
}
function response() {
  const res = { status: 0, body: '', headersSent: false, headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { res.headers[name] = value },
    writeHead(status: number) { res.status = status; res.headersSent = true },
    end(text: string) { res.body = text } }
  return res
}
const sign = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex')
const delivery = (at = NOW) => JSON.stringify({ type: 'AgentSessionEvent', action: 'created', webhookTimestamp: at })

async function call(req: IncomingMessage, file = secretFile) {
  const res = response(), wake = vi.fn()
  await handleWebhook(req, res as unknown as ServerResponse, { secretFile: () => file, wake, now: () => NOW })
  return { res, wake }
}

describe('Linear webhook', () => {
  it('wakes the loop for a signed, fresh delivery', async () => {
    const body = delivery()
    const { res, wake } = await call(request('POST', body, { 'linear-signature': sign(body) }))
    expect(res.status).toBe(200)
    expect(wake).toHaveBeenCalledOnce()
  })
  it('refuses a bad, missing or foreign signature without waking', async () => {
    const body = delivery()
    const cases: Record<string, string>[] = [{ 'linear-signature': sign(body, 'other') }, {}, { 'linear-signature': 'zz' }]
    for (const headers of cases) {
      const { res, wake } = await call(request('POST', body, headers))
      expect(res.status).toBe(401)
      expect(wake).not.toHaveBeenCalled()
    }
  })
  it('refuses a replayed delivery whose timestamp is over a minute off', async () => {
    const body = delivery(NOW - 61_000)
    const { res, wake } = await call(request('POST', body, { 'linear-signature': sign(body) }))
    expect(res.status).toBe(401)
    expect(wake).not.toHaveBeenCalled()
  })
  it('answers 405 to anything but POST', async () => {
    const { res, wake } = await call(request('GET', ''))
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('POST')
    expect(wake).not.toHaveBeenCalled()
  })
  it('answers 503 while no secret file is set or readable', async () => {
    const body = delivery()
    for (const file of ['', join(dir, 'missing')]) {
      const { res, wake } = await call(request('POST', body, { 'linear-signature': sign(body) }), file)
      expect(res.status).toBe(503)
      expect(wake).not.toHaveBeenCalled()
    }
  })
  it('answers 413 to a body over 1 MiB', async () => {
    const { res, wake } = await call(request('POST', Buffer.alloc(1024 * 1024 + 1, 'a')))
    expect(res.status).toBe(413)
    expect(wake).not.toHaveBeenCalled()
  })
  it('answers 400 to a signed body that is not JSON', async () => {
    const body = 'not json'
    const { res } = await call(request('POST', body, { 'linear-signature': sign(body) }))
    expect(res.status).toBe(400)
  })
})

describe('Waker', () => {
  it('ends a wait early when woken, and a wake between waits ends the next one at once', async () => {
    const waker = new Waker(), signal = new AbortController().signal
    const waiting = waker.wait(60_000, signal)
    waker.wake()
    await waiting
    waker.wake()
    const started = Date.now()
    await waker.wait(60_000, signal)
    expect(Date.now() - started).toBeLessThan(1000)
  })
  it('ends a wait when the signal aborts', async () => {
    const waker = new Waker(), controller = new AbortController()
    const waiting = waker.wait(60_000, controller.signal)
    controller.abort()
    await waiting
  })
})
