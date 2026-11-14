/** Chains: a person's session on an Issue with sub-issues works through them, each in a session of its own, in the order their `blocks` relations allow. */
import { LinearError, stableUuid, type Chain, type Issue, type IssueContext, type LinearClient, type Prompt, type Session } from './linear-api.ts'
import { CLOSE_HORIZON_MS, KEYS, SOURCE, channel, meta, placed, routeOf, threadOf, withContext, type LinearConfig, type Round } from './linear.ts'
import type { SourceContext, Ticket, Trigger } from './types.ts'

export const CHAIN_KEYS = {
  chain: (epic: string) => `linear-chain:${epic}`,
  sessions: 'linear-chain-sessions',
  chains: 'linear-chains',
  run: (session: string) => `linear-chain-run:${session}`,
  held: (session: string) => `linear-chain-held:${session}`,
}
export const CHAIN_INTERVAL_MS = 30_000
export const CHAIN_WAIT_MS = 30 * 60_000
export const HOLD_MS = 10 * 60_000

export interface Started { identifier: string; at: string; session?: string; url?: string; trigger?: string; ticket?: string }
export interface ChainRecord {
  run: string; session: string; delegator: { id: string; name?: string }; status: 'running' | 'stopped' | 'done'; reason?: string
  team: string; teamKey: string; project?: string; projectName?: string; identifier: string; url: string
  delegated: boolean; started: Record<string, Started>; children?: { id: string; identifier: string }[]; checked?: string
}
type Child = Chain['children']['nodes'][number]
interface Env { ctx: SourceContext; client: LinearClient; config: LinearConfig; viewer: string; round: Round; signal: AbortSignal }

export const chainOf = (ctx: SourceContext, epic: string): ChainRecord | undefined => {
  const record = ctx.state.get<ChainRecord>(CHAIN_KEYS.chain(epic))
  return record && structuredClone(record)
}
const save = (ctx: SourceContext, epic: string, record: ChainRecord) => ctx.state.set(CHAIN_KEYS.chain(epic), structuredClone(record))
const active = (ctx: SourceContext) => ctx.state.get<string[]>(CHAIN_KEYS.chains) ?? []
function setActive(ctx: SourceContext, epic: string, on: boolean): void {
  const list = active(ctx).filter(id => id !== epic)
  ctx.state.set(CHAIN_KEYS.chains, on ? [...list, epic] : list)
}
export const ownSession = (ctx: SourceContext, id: string) => !!ctx.state.get<Record<string, string>>(CHAIN_KEYS.sessions)?.[id]
function addOwnSession(ctx: SourceContext, id: string): void {
  const now = Date.now()
  const kept = Object.entries(ctx.state.get<Record<string, string>>(CHAIN_KEYS.sessions) ?? {}).filter(([, at]) => now - Date.parse(at) < CLOSE_HORIZON_MS)
  ctx.state.set(CHAIN_KEYS.sessions, Object.fromEntries([...kept, [id, new Date(now).toISOString()]]))
}
const ignoreGone = (error: unknown) => { if (!(error instanceof LinearError && error.gone)) throw error }
/** Throws while `key` has been held for less than HOLD_MS, so the round reads it again; returns once the hold ran out. */
export function holdUnreadable(ctx: SourceContext, key: string): void {
  const held = ctx.state.get<string>(CHAIN_KEYS.held(key))
  if (!held) ctx.state.set(CHAIN_KEYS.held(key), new Date().toISOString())
  if (!held || Date.now() - Date.parse(held) < HOLD_MS) throw new Error('The sub-issues of a delegated Issue were not readable')
}
export function releaseHold(ctx: SourceContext, key: string): void {
  if (ctx.state.get(CHAIN_KEYS.held(key))) ctx.state.set(CHAIN_KEYS.held(key), undefined)
}
export const unreadableText = (identifier: string) => `Could not read the sub-issues of ${identifier}; write "start" in this session to retry.`
const closed = (state: { type: string } | null | undefined) => state?.type === 'completed' || state?.type === 'canceled'

interface Start { run: string; session: string; issue: Issue; delegator: { id: string; name?: string | null } }
/** Starts a fresh run, replacing any earlier one; the children that run started and are still busy carry over. Idempotent per `run`. */
async function startRun(ctx: SourceContext, client: LinearClient, start: Start, context: IssueContext, viewer: string, parallel: number,
  signal: AbortSignal): Promise<void> {
  const { issue, run, session, delegator } = start
  const before = chainOf(ctx, issue.id)
  if (before?.run !== run) {
    const carried = before?.status === 'running' ? [...busy(ctx, before)].flatMap(id => before.started[id] ? [[id, before.started[id]] as const] : []) : []
    save(ctx, issue.id, { run, session, delegator: { id: delegator.id, ...delegator.name ? { name: delegator.name } : {} },
      status: 'running', team: issue.team.id, teamKey: issue.team.key, ...issue.project ? { project: issue.project.id, ...issue.project.name ? { projectName: issue.project.name } : {} } : {},
      identifier: issue.identifier, url: issue.url, delegated: issue.delegate?.id === viewer, started: Object.fromEntries(carried) })
  }
  setActive(ctx, issue.id, true)
  const list = context.children.nodes.map(child => `${child.identifier}${closed(child.state) ? ' (done)' : ''}`).join(', ')
  const more = context.children.pageInfo.hasNextPage ? ' and more' : ''
  await client.activity(session, stableUuid(`chain-plan:${run}`), { type: 'thought',
    body: `Working through the sub-issues of ${issue.identifier} in the order their blocking relations allow, at most ${parallel} at a time: ${list}${more}.` }, false, signal)
    .catch(ignoreGone)
  ctx.state.set(CHAIN_KEYS.run(run), issue.id)
}
export async function startChain(ctx: SourceContext, client: LinearClient, session: Session, context: IssueContext, viewer: string, parallel: number,
  signal: AbortSignal): Promise<void> {
  await startRun(ctx, client, { run: session.id, session: session.id, issue: session.issue!, delegator: session.creator! }, context, viewer, parallel, signal)
}

/** Answers a prompt on an epic, never a Trigger: stops its chain, starts one (a new delegation reuses the session), or notes its status. */
export async function epicPrompt(ctx: SourceContext, client: LinearClient, prompt: Prompt, trigger: Trigger, viewer: string, parallel: number,
  signal: AbortSignal): Promise<boolean> {
  const epic = String(trigger.meta.issue)
  if (ctx.state.get(CHAIN_KEYS.run(prompt.id))) return true
  const record = chainOf(ctx, epic)
  const stop = trigger.meta.signal === 'stop'
  const identifier = String(trigger.meta.identifier)
  let context: IssueContext | undefined
  if (!stop && record?.status !== 'running' && trigger.meta.delegate === viewer) {
    try {
      context = await client.issueContext(epic, signal)
    } catch (error) {
      if (signal.aborted) throw error
      holdUnreadable(ctx, prompt.id)
      await client.activity(prompt.agentSession.id, stableUuid(`unreadable:${prompt.id}`), { type: 'error', body: unreadableText(identifier) }, false, signal)
        .catch(ignoreGone)
      ctx.state.set(CHAIN_KEYS.run(prompt.id), epic)
      releaseHold(ctx, prompt.id)
      return true
    }
    releaseHold(ctx, prompt.id)
    if (context.children.nodes.some(child => !closed(child.state))) {
      await startRun(ctx, client, { run: prompt.id, session: prompt.agentSession.id, issue: prompt.agentSession.issue!, delegator: prompt.user! },
        context, viewer, parallel, signal)
      return true
    }
  }
  const labels = Array.isArray(trigger.meta.labels) ? trigger.meta.labels : []
  if (!record && !labels.some(label => String(label).toLowerCase() === 'epic')
    && !(context ? context.children.nodes.length > 0 : await client.hasChildren(epic, signal))) return false
  if (record?.status === 'running' && stop) {
    await stopChain(ctx, client, epic, record, 'stop requested in Linear', { id: trigger.actor.id }, signal)
    return true
  }
  await client.activity(String(trigger.meta.session), stableUuid(`epic-prompt:${String(trigger.meta.activity)}`),
    { type: 'thought', body: statusText(ctx, record, identifier, 'the app') }, false, signal).catch(ignoreGone)
  return true
}

/** Answers a mention on an Issue with sub-issues: only a delegation starts a chain. */
export async function epicMention(ctx: SourceContext, client: LinearClient, session: Session, signal: AbortSignal): Promise<void> {
  const issue = session.issue!
  await client.activity(session.id, stableUuid(`epic-mention:${session.id}`),
    { type: 'thought', body: statusText(ctx, chainOf(ctx, issue.id), issue.identifier, session.appUser?.name || 'the app') }, false, signal).catch(ignoreGone)
  ctx.state.set(CHAIN_KEYS.run(session.id), issue.id)
}

function statusText(ctx: SourceContext, record: ChainRecord | undefined, identifier: string, app: string): string {
  if (record?.status !== 'running') {
    return `Not working on ${identifier}${record?.reason ? ` (stopped: ${record.reason})` : ''}. To start a chain, delegate the issue to ${app}, then write "start" in its session.`
  }
  const working = [...busy(ctx, record)].map(id => identifierOf(record, id))
  return `Working on ${working.length ? working.join(', ') : 'the next sub-issues'} of ${identifier}. A stop in this session ends the chain.`
}

const identifierOf = (record: ChainRecord, id: string) =>
  record.started[id]?.identifier ?? record.children?.find(child => child.id === id)?.identifier ?? id
function openTickets(ctx: SourceContext): Map<string, Ticket[]> {
  const open = new Map<string, Ticket[]>()
  for (const ticket of ctx.tickets.open()) {
    const origin = ctx.triggers.get(ticket.origin.triggerId)
    if (origin?.source !== SOURCE || typeof origin.meta.issue !== 'string') continue
    open.set(origin.meta.issue, [...open.get(origin.meta.issue) ?? [], ticket])
  }
  return open
}
/** The record's children that hold a worker or wait for one: an open ticket, a start without a ticket yet, or an ended ticket whose Issue is being completed. */
function busy(ctx: SourceContext, record: ChainRecord, done: (id: string) => boolean = () => false): Set<string> {
  const open = openTickets(ctx)
  const followed = new Set(ctx.state.get<string[]>(KEYS.followed) ?? [])
  const ids = new Set([...(record.children ?? []).map(child => child.id), ...Object.keys(record.started)])
  return new Set([...ids].filter(id => {
    if (done(id)) return false
    if (open.has(id)) return true
    const started = record.started[id]
    return !!started && (!started.ticket || followed.has(started.ticket))
  }))
}
/** Records the ticket each started child got, open or already ended. */
function observe(ctx: SourceContext, record: ChainRecord): boolean {
  const ids = new Set([...ctx.tickets.open().map(ticket => ticket.id), ...ctx.state.get<string[]>(KEYS.followed) ?? [], ...ctx.state.get<string[]>(KEYS.closing) ?? []])
  const tickets = [...ids].flatMap(id => { const ticket = ctx.tickets.get(id); return ticket ? [ticket] : [] })
  let changed = false
  for (const [child, started] of Object.entries(record.started)) {
    if (started.ticket || !started.trigger) continue
    const ticket = tickets.find(ticket => ctx.triggers.get(ticket.origin.triggerId)?.meta.issue === child && (!ticket.ended || ticket.ended.at >= started.at))
    if (ticket) { started.ticket = ticket.id; changed = true }
  }
  return changed
}

/** One step of every active chain: each epic is read at most every 30 seconds, at once when one of its children's tickets ended. */
export async function advanceChains(ctx: SourceContext, client: LinearClient, config: LinearConfig, viewer: string, round: Round, signal: AbortSignal): Promise<void> {
  for (const epic of active(ctx)) {
    if (signal.aborted) throw new Error('The Linear Source stopped during the chains')
    const record = chainOf(ctx, epic)
    if (!record) { setActive(ctx, epic, false); continue }
    try { await advance({ ctx, client, config, viewer, round, signal }, epic, record) }
    catch (error) { if (signal.aborted) throw error; round.chainFailed++ }
  }
}

async function advance(env: Env, epic: string, record: ChainRecord): Promise<void> {
  const { ctx, client, viewer, signal } = env
  if (record.status === 'done') return await finish(env, epic, record)
  if (record.status !== 'running') { setActive(ctx, epic, false); return }
  if (observe(ctx, record)) save(ctx, epic, record)
  const checked = record.checked ? Date.parse(record.checked) : undefined
  const ended = Object.values(record.started).some(started => {
    const at = started.ticket ? ctx.tickets.get(started.ticket)?.ended?.at : undefined
    return at !== undefined && checked !== undefined && Date.parse(at) > checked
  })
  if (checked !== undefined && Date.now() - checked < CHAIN_INTERVAL_MS && !ended) return
  const chain = await client.chainRead(epic, signal)
  record.checked = new Date().toISOString()
  save(ctx, epic, record)
  const stop = (reason: string) => stopChain(ctx, client, epic, record, reason, undefined, signal)

  if (chain.delegate?.id === viewer) record.delegated = true
  else if (record.delegated) return await stop(`${record.identifier} is no longer delegated to the app`)
  if (closed(chain.state)) return await stop(`${record.identifier} was ${chain.state!.type}`)
  const children = chain.children.nodes
  if (chain.children.pageInfo.hasNextPage || children.some(child => child.inverseRelations.pageInfo.hasNextPage)) {
    return await stop('too many sub-issues or relations to read (at most 30 sub-issues and 20 relations on each)')
  }
  if (!children.length) return await stop(`${record.identifier} has no sub-issues`)
  record.children = children.map(child => ({ id: child.id, identifier: child.identifier }))

  const byId = new Map(children.map(child => [child.id, child]))
  const done = (id: string) => closed(byId.get(id)?.state)
  const open = openTickets(ctx)
  const running = busy(ctx, record, done)
  const failed = children.filter(child => {
    const ticket = record.started[child.id]?.ticket
    if (!ticket || done(child.id) || running.has(child.id)) return false
    return !ctx.tickets.get(ticket) || !!ctx.tickets.get(ticket)!.ended
  })
  if (failed.length) return await stop(`${failed.map(child => child.identifier).join(', ')} ended without being completed`)
  const now = Date.now()
  const unticketed = children.filter(child => {
    const started = record.started[child.id]
    return started?.trigger && !started.ticket && !done(child.id) && !open.has(child.id) && now - Date.parse(started.at) >= CHAIN_WAIT_MS
  })
  if (unticketed.length) return await stop(`${unticketed.map(child => child.identifier).join(', ')} got no ticket within ${CHAIN_WAIT_MS / 60_000} minutes`)
  if (children.every(child => done(child.id))) {
    record.status = 'done'
    save(ctx, epic, record)
    return await finish(env, epic, record)
  }

  const blockers = (child: Child) => child.inverseRelations.nodes.flatMap(relation => relation.type === 'blocks' && relation.issue ? [relation.issue] : [])
  const elsewhere = children.filter(child => !done(child.id) && !running.has(child.id) && !record.started[child.id]
    && !!child.assignee && child.assignee.id !== viewer)
  const ready = children.filter(child => !done(child.id) && !running.has(child.id) && !record.started[child.id] && !elsewhere.includes(child)
    && blockers(child).every(blocker => closed(blocker.state)))
    .sort((a, b) => (a.subIssueSortOrder ?? Infinity) - (b.subIssueSortOrder ?? Infinity) || a.identifier.localeCompare(b.identifier, 'en', { numeric: true }))
  if (!running.size && !ready.length && !elsewhere.length) {
    const waits = children.filter(child => !done(child.id)).map(child => {
      const waiting = blockers(child).filter(blocker => !closed(blocker.state)).map(blocker => blocker.identifier)
      return waiting.length ? `${child.identifier} waits for ${waiting.join(', ')}` : child.identifier
    })
    return await stop(`stalled: ${waits.join('; ')}`)
  }

  for (const child of children) {
    const started = record.started[child.id]
    if (started && (!started.session || !started.trigger) && !done(child.id) && await launch(env, epic, record, child.id) === 'stopped') return
  }
  let count = running.size + active(ctx).filter(other => other !== epic).reduce((sum, other) => {
    const chain = chainOf(ctx, other)
    return sum + (chain?.status === 'running' ? busy(ctx, chain).size : 0)
  }, 0)
  for (const child of ready) {
    if (count >= env.config.chainParallel) break
    record.started[child.id] = { identifier: child.identifier, at: new Date().toISOString() }
    save(ctx, epic, record)
    count++
    if (await launch(env, epic, record, child.id) === 'stopped') return
  }

  save(ctx, epic, record)
}

export function chainTrigger(issue: Issue, session: string, url: string, epic: string, record: ChainRecord, at: string): Trigger {
  const { delegate: _, ...rest } = meta(issue, session, 'chain')
  return { id: `linear:chain:${record.run}:${issue.id}`, source: SOURCE, threads: [{ source: SOURCE, id: threadOf(issue.id) }],
    actor: { source: SOURCE, id: record.delegator.id }, human: true, addressed: 'direct', at,
    text: `${issue.identifier}: ${issue.title}\n\n${issue.description ?? ''}`.trim(), channel: channel(issue, session, url), url, meta: { ...rest, chain: epic } }
}

/** Takes a started child as far as its Trigger: a session of its own, recorded before anything else can see it, then the Trigger. */
async function launch(env: Env, epic: string, record: ChainRecord, child: string): Promise<'started' | 'stopped'> {
  const { ctx, client, config, signal } = env
  const started = record.started[child]!
  const issue = await client.issue(child, signal)
  const where = routeOf(ctx, config, chainTrigger(issue, '', issue.url, epic, record, started.at))
  if (where.kind !== 'served') {
    await stopChain(ctx, client, epic, record, `${issue.identifier} works in no repository this deployment serves`, undefined, signal)
    return 'stopped'
  }
  if (!started.session) {
    const created = await client.createSession(child, signal)
    addOwnSession(ctx, created.id)
    started.session = created.id
    started.url = created.url ?? issue.url
    save(ctx, epic, record)
  }
  const session = started.session
  if (!ctx.state.get(KEYS.seen(session))) {
    await client.activity(session, stableUuid(`seen:${session}`), { type: 'thought', body: 'Received.' }, true, signal).catch(ignoreGone)
    ctx.state.set(KEYS.seen(session), true)
  }
  const context = await client.issueContext(child, signal).catch((error: unknown) => { if (signal.aborted) throw error; env.round.contextFailed++; return undefined })
  const trigger = placed(ctx, withContext(chainTrigger(issue, session, started.url ?? issue.url, epic, record, started.at), context), where.repository)
  if (await ctx.receive(trigger) === 'filtered') {
    await stopChain(ctx, client, epic, record, `${issue.identifier} was filtered by the admission table`, undefined, signal)
    return 'stopped'
  }
  started.trigger = trigger.id
  save(ctx, epic, record)
  return 'started'
}

/** Stops a chain: its children's open tickets get a stop Trigger, the epic's session the reason, and the epic leaves the active chains. */
export async function stopChain(ctx: SourceContext, client: LinearClient, epic: string, record: ChainRecord, reason: string, by: { id: string } | undefined,
  signal: AbortSignal): Promise<void> {
  const open = openTickets(ctx)
  const at = new Date().toISOString()
  const stopped = new Set<string>()
  const stopTrigger = (origin: Trigger, child: string, repository: string | undefined): Trigger => {
    const { team, teamKey, issue, identifier, session } = origin.meta
    return { id: `linear:chain-stop:${record.run}:${child}`, source: SOURCE, threads: origin.threads, actor: { source: SOURCE, id: by?.id ?? '' },
      human: !!by, addressed: 'direct', at, text: `Stop requested in Linear.\n\nThe work on the sub-issues of ${record.identifier} stopped: ${reason}.`,
      ...origin.channel ? { channel: origin.channel } : {}, ...origin.url ? { url: origin.url } : {},
      meta: { team, teamKey, issue, identifier, session, kind: 'chain-stop', signal: 'stop', chain: epic, ...repository ? { repository } : {} } }
  }
  for (const child of new Set([...(record.children ?? []).map(child => child.id), ...Object.keys(record.started)])) {
    for (const ticket of open.get(child) ?? []) {
      const origin = ctx.triggers.get(ticket.origin.triggerId)!
      if (!(origin.meta.kind === 'chain' && origin.meta.chain === epic) && record.started[child]?.ticket !== ticket.id) continue
      const repository = ticket.execution?.repository ?? (typeof origin.meta.repository === 'string' ? origin.meta.repository : undefined)
      await ctx.receive(stopTrigger(origin, child, repository))
      stopped.add(child)
    }
    const started = record.started[child]
    const origin = started?.trigger && !started.ticket && !stopped.has(child) ? ctx.triggers.get(started.trigger) : undefined
    if (origin) await ctx.receive(stopTrigger(origin, child, typeof origin.meta.repository === 'string' ? origin.meta.repository : undefined))
  }
  await client.activity(record.session, stableUuid(`chain-stop:${record.run}`), { type: 'response', body: `Stopped: ${reason}.` }, false, signal).catch(ignoreGone)
  record.status = 'stopped'
  record.reason = reason
  save(ctx, epic, record)
  setActive(ctx, epic, false)
}

/** Completes the epic and lists its children with their pull requests; status `done` is written before, so a crash in between completes it next round. */
async function finish(env: Env, epic: string, record: ChainRecord): Promise<void> {
  const { ctx, client, signal } = env
  await client.complete(epic, signal)
  const pulls = (child: string) => {
    const ticket = record.started[child]?.ticket ? ctx.tickets.get(record.started[child].ticket) : undefined
    return (ticket?.follows ?? []).filter(follow => follow.own).flatMap(follow => {
      const url = ctx.threads.get(follow.thread)?.meta.url
      return typeof url === 'string' && url ? [url] : []
    })
  }
  const lines = (record.children ?? []).map(child => `- ${child.identifier}${pulls(child.id).map(url => ` ${url}`).join('')}`)
  await client.activity(record.session, stableUuid(`chain-done:${record.run}`), { type: 'response',
    body: `All sub-issues of ${record.identifier} are done.\n\n${lines.join('\n')}` }, false, signal).catch(ignoreGone)
  setActive(ctx, epic, false)
}
