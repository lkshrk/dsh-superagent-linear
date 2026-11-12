/** Plugin entry: registers the Linear Source kind with dsh-superagent's `orchestrator` service and runs its polling loop. */
import { LinearClient } from './linear-api.ts'
import { HEALTH, SOURCE, linearKind, watchLinear, type LinearConfig } from './linear.ts'
import type { SourceContext, SourceHost } from './types.ts'

interface PluginContext {
  orchestrator: SourceHost
  effect(execute: () => (() => unknown) | void, label?: string): unknown
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
  const kind = linearKind(client)
  ctx.effect(() => orchestrator.sources.register(kind), 'linear: source kind')
  ctx.effect(() => {
    const context = source = orchestrator.context(kind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watchLinear(context, client, controller.signal)
      .catch((error: unknown) => { context.report(HEALTH, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
export { LinearClient, SCOPE, stableUuid } from './linear-api.ts'
export { linearKind, pollLinear, promptTrigger, sessionTrigger, LinearConfigSchema, type LinearConfig } from './linear.ts'
