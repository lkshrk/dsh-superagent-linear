/** Plugin entry: registers the Linear Source kind with dsh-superagent's `orchestrator` service and runs its polling loop. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LinearClient } from './linear-api.ts'
import { HEALTH, SOURCE, linearKind, watchLinear, type LinearConfig } from './linear.ts'
import type { SourceContext, SourceHost } from './types.ts'
import { WEBHOOK_PATH, Waker, handleWebhook } from './webhook.ts'

interface WebServer {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void
}
interface PluginContext {
  orchestrator: SourceHost
  webServer?: WebServer
  effect(execute: () => (() => unknown) | void, label?: string): unknown
  inject?(deps: string[], apply: (child: PluginContext) => void): unknown
}

export const name = 'dsh-superagent-linear'
export const inject = ['orchestrator']
export function apply(ctx: PluginContext): void {
  const orchestrator = ctx.orchestrator
  let source: SourceContext | undefined
  const config = () => {
    const current = source?.config<LinearConfig>(SOURCE)
    if (!current) throw new Error('The Linear Source is off')
    return current
  }
  const client = new LinearClient(() => config())
  const waker = new Waker()
  const kind = linearKind(client)
  ctx.effect(() => orchestrator.sources.register(kind), 'linear: source kind')
  ctx.effect(() => {
    const context = source = orchestrator.context(kind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watchLinear(context, client, controller.signal, waker)
      .catch((error: unknown) => { context.report(HEALTH, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
  if (!ctx.inject) console.log(`${name}: this DSH cannot inject optional services, so ${WEBHOOK_PATH} is not served`)
  ctx.inject?.(['webServer'], child => {
    child.effect(() => child.webServer!.register({ kind: 'exact', path: WEBHOOK_PATH, handler: (req, res) => handleWebhook(req, res, {
      secretFile: () => source?.config<LinearConfig>(SOURCE)?.webhookSecretFile ?? '', wake: () => { waker.wake() } }) }),
    `linear: ${WEBHOOK_PATH} route`)
  })
}
export { LinearClient, SCOPE, stableUuid } from './linear-api.ts'
export { linearKind, pollLinear, promptTrigger, sessionTrigger, LinearConfigSchema, type LinearConfig } from './linear.ts'
