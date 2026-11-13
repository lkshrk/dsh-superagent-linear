/** Linear webhook intake: a signed delivery wakes the poll loop, which reads the session through the API as before. */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const WEBHOOK_PATH = '/hooks/linear'
const MAX_BODY = 1024 * 1024
const READ_TIMEOUT_MS = 10_000
/** How far a delivery's `webhookTimestamp` may be from now; Linear recommends a minute. */
const MAX_SKEW_MS = 60_000
/** The shortest wait between rounds however many deliveries arrive, as each round costs several API requests. */
const MIN_GAP_MS = 2_000

/** Ends a poll loop's wait early, but never before `minMs`; a wake during a round shortens the next wait to `minMs`. */
export class Waker {
  private pending = false
  private early?: () => void
  wake(): void { if (this.early) this.early(); else this.pending = true }
  /** Waits `ms`, or `minMs` once woken, or until `signal` aborts. */
  wait(ms: number, signal: AbortSignal, minMs = MIN_GAP_MS): Promise<void> {
    if (signal.aborted) { this.pending = false; return Promise.resolve() }
    const started = Date.now()
    return new Promise(done => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); this.early = undefined; done() }
      const arm = (delay: number) => { clearTimeout(timer); timer = setTimeout(finish, delay); timer.unref?.() }
      arm(this.pending ? minMs : ms)
      this.pending = false
      this.early = () => { arm(Math.max(0, minMs - (Date.now() - started))) }
      signal.addEventListener('abort', finish, { once: true })
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
  const timer = setTimeout(() => { req.destroy(new Error('Request body timed out')) }, READ_TIMEOUT_MS)
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) return undefined
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
  } finally { clearTimeout(timer) }
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
  if (Number(req.headers['content-length']) > MAX_BODY) { send(res, 413, 'too large'); return }
  const body = await readBody(req)
  if (!body) { send(res, 413, 'too large'); return }
  const file = options.secretFile()
  const secret = file ? (await readFile(file, 'utf8').catch(() => '')).trim() : ''
  if (!secret) { send(res, 503, 'webhook not configured'); return }
  if (!signed(secret, body, req.headers['linear-signature'])) { send(res, 401, 'bad signature'); return }
  let at: unknown
  try { at = (JSON.parse(body.toString('utf8')) as { webhookTimestamp?: unknown } | null)?.webhookTimestamp } catch { send(res, 400, 'bad body'); return }
  if (typeof at !== 'number') { send(res, 400, 'bad body'); return }
  // A retry can carry its first attempt's timestamp; refusing it would make Linear count failures and disable the webhook.
  if (Math.abs((options.now ?? Date.now)() - at) > MAX_SKEW_MS) { send(res, 200, 'stale, ignored'); return }
  send(res, 200, 'ok')
  options.wake()
}
