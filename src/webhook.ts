/** Linear webhook intake: a signed delivery wakes the poll loop, which reads the session through the API as before. */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const WEBHOOK_PATH = '/hooks/linear'
const MAX_BODY = 1024 * 1024
/** How far a delivery's `webhookTimestamp` may be from now; Linear recommends a minute. */
const MAX_SKEW_MS = 60_000

/** Ends a poll loop's wait early; a wake during a round makes the next wait return at once. */
export class Waker {
  private pending = false
  private resolve?: () => void
  wake(): void { if (this.resolve) this.resolve(); else this.pending = true }
  /** Waits `ms`, or less when woken or when `signal` aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void> {
    if (this.pending || signal.aborted) { this.pending = false; return Promise.resolve() }
    return new Promise(done => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); this.resolve = undefined; done() }
      const timer = setTimeout(finish, ms)
      timer.unref?.()
      signal.addEventListener('abort', finish, { once: true })
      this.resolve = finish
    })
  }
}

export interface WebhookOptions {
  /** The file holding the webhook's signing secret, or '' when the webhook is off. */
  secretFile(): string
  wake(): void
  now?: () => number
}

function send(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(`${text}\n`)
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) return undefined
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function signed(secret: string, body: Buffer, header: string | string[] | undefined): boolean {
  if (typeof header !== 'string' || !/^[0-9a-f]{64}$/i.test(header)) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  return timingSafeEqual(expected, Buffer.from(header, 'hex'))
}

/** Answers one delivery: only a POST whose signature and timestamp check out wakes the loop. A failed read answers 400. */
export async function handleWebhook(req: IncomingMessage, res: ServerResponse, options: WebhookOptions): Promise<void> {
  await answer(req, res, options).catch(() => { if (!res.headersSent) send(res, 400, 'bad request') })
}

async function answer(req: IncomingMessage, res: ServerResponse, options: WebhookOptions): Promise<void> {
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); send(res, 405, 'method not allowed'); return }
  const file = options.secretFile()
  const secret = file ? (await readFile(file, 'utf8').catch(() => '')).trim() : ''
  if (!secret) { send(res, 503, 'webhook not configured'); return }
  const body = await readBody(req)
  if (!body) { send(res, 413, 'too large'); return }
  if (!signed(secret, body, req.headers['linear-signature'])) { send(res, 401, 'bad signature'); return }
  let at: unknown
  try { at = (JSON.parse(body.toString('utf8')) as { webhookTimestamp?: unknown }).webhookTimestamp } catch { send(res, 400, 'bad body'); return }
  if (typeof at !== 'number' || Math.abs((options.now ?? Date.now)() - at) > MAX_SKEW_MS) { send(res, 401, 'stale'); return }
  send(res, 200, 'ok')
  options.wake()
}
