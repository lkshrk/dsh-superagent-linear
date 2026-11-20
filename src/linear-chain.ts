/** Chains: a person's session on an Issue with sub-issues works through them, each in a session of its own, in the order their `blocks` relations allow. */
import { LinearError, stableUuid, type ActivityContent, type Chain, type Issue, type IssueContext, type IssueStatus, type LinearClient, type Prompt, type Session } from './linear-api.ts'
import { CLOSE_HORIZON_MS, KEYS, SOURCE, channel, issueText, meta, placed, routeOf, threadOf, withContext, withMode, withParentDocuments, type LinearConfig, type Round } from './linear.ts'
import type { SourceContext, Ticket, Trigger } from './types.ts'

export const CHAIN_KEYS = {
  chain: (epic: string) => `linear-chain:${epic}`,
  sessions: 'linear-chain-sessions',
  chains: 'linear-chains',
  run: (session: string) => `linear-chain-run:${session}`,
  held: (session: string) => `linear-chain-held:${session}`,
  watched: 'linear-watched',
  delegated: 'linear-delegated-checked',
  redelegations: 'linear-redelegations',
}
/** How long a re-delegated Issue without sub-issues waits for a session Linear may open for the delegation itself. */
export const DELEGATION_GRACE_MS = 60_000
/** How long after its delegation a start that keeps failing is retried. */
export const REDELEGATION_GIVE_UP_MS = 24 * 3600_000
/** How long after a delegation started a run a new session on the epic joins it instead of starting another. */
export const ADOPT_MS = 2 * 60_000
export const CHAIN_INTERVAL_MS = 30_000
export const CHAIN_WAIT_MS = 30 * 60_000
export const HOLD_MS = 10 * 60_000

export interface Started { identifier: string; at: string; session?: string; url?: string; trigger?: string; ticket?: string }
export interface ChainRecord {
  run: string; session: string; delegator: { id: string; name?: string }; status: 'running' | 'stopped' | 'done'; reason?: string
  team: string; teamKey: string; project?: string; projectName?: string; identifier: string; url: string
  delegated: boolean; started: Record<string, Started>; children?: { id: string; identifier: string }[]; checked?: string
  delegation?: { at: string }; waiting?: string
}
type Child = Chain['children']['nodes'][number]
const UNREADABLE_BLOCKER = { id: '', identifier: 'an issue the app cannot read', state: null }
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
/** Whether `actor` may start or stop a chain: the host's policy admits it; nobody may on a host without `admits`. */
export const mayControl = (ctx: SourceContext, actor: string | undefined) => !!actor && ctx.admits?.({ id: actor, human: true }) === true
const ignoreGone = (error: unknown) => { if (!(error instanceof LinearError && error.gone)) throw error }
/** Posts to a session once per id; a run started without a known session posts nothing. */
async function tell(client: LinearClient, session: string, id: string, content: ActivityContent, signal: AbortSignal): Promise<void> {
  if (session) await client.activity(session, stableUuid(id), content, false, signal).catch(ignoreGone)
}
/** Throws while `key` has been held for less than HOLD_MS, so the round reads it again; returns once the hold ran out. */
export function holdUnreadable(ctx: SourceContext, key: string): void {
  const held = ctx.state.get<string>(CHAIN_KEYS.held(key))
  if (!held) ctx.state.set(CHAIN_KEYS.held(key), new Date().toISOString())
  if (!held || Date.now() - Date.parse(held) < HOLD_MS) throw new Error(`The sub-issues of the Issue of ${key} were not readable`)
}
export function releaseHold(ctx: SourceContext, key: string): void {
  if (ctx.state.get(CHAIN_KEYS.held(key))) ctx.state.set(CHAIN_KEYS.held(key), undefined)
}
export const unreadableText = (identifier: string, delegated = true) =>
  `Could not read the sub-issues of ${identifier}; ${delegated ? 'write exactly "start" in this session' : 'mention the app again'} to retry.`
const closed = (state: { type: string } | null | undefined) => state?.type === 'completed' || state?.type === 'canceled'

interface Start { run: string; session: string; issue: Issue; delegator: { id: string; name?: string | null }; delegation?: boolean }
/** Starts a fresh run, replacing any earlier one; the children that run started and are still busy carry over. Idempotent per `run`. */
async function startRun(ctx: SourceContext, client: LinearClient, start: Start, context: IssueContext, viewer: string, parallel: number,
  signal: AbortSignal): Promise<void> {
  const { issue, run, session, delegator } = start
  const before = chainOf(ctx, issue.id)
  if (before?.run !== run) {
    const carried = before?.status === 'running' ? [...busy(ctx, before)].flatMap(id => before.started[id] ? [[id, before.started[id]] as const] : []) : []
    save(ctx, issue.id, { run, session, delegator: { id: delegator.id, ...delegator.name ? { name: delegator.name } : {} },
      status: 'running', team: issue.team.id, teamKey: issue.team.key, ...issue.project ? { project: issue.project.id, ...issue.project.name ? { projectName: issue.project.name } : {} } : {},
      identifier: issue.identifier, url: issue.url, delegated: issue.delegate?.id === viewer, started: Object.fromEntries(carried),
      ...start.delegation ? { delegation: { at: new Date().toISOString() } } : {} })
  }
  setActive(ctx, issue.id, true)
  watch(ctx, issue.id, session)
  await tell(client, session, `chain-plan:${run}`, { type: 'thought', body: planText(issue, context, parallel) }, signal)
  ctx.state.set(CHAIN_KEYS.run(run), issue.id)
}
function planText(issue: Issue, context: IssueContext, parallel: number): string {
  const list = context.children.nodes.map(child => `${child.identifier}${closed(child.state) ? ' (done)' : ''}`).join(', ')
  const more = context.children.pageInfo.hasNextPage ? ' and more' : ''
  return `Working through the sub-issues of ${issue.identifier} in the order their blocking relations allow, at most ${parallel} at a time: ${list}${more}.`
}
export async function startChain(ctx: SourceContext, client: LinearClient, session: Session, context: IssueContext, viewer: string, parallel: number,
  signal: AbortSignal): Promise<void> {
  const record = chainOf(ctx, session.issue!.id)
  if (record?.status === 'running' && record.delegation && Date.now() - Date.parse(record.delegation.at) < ADOPT_MS) {
    record.session = session.id
    save(ctx, session.issue!.id, record)
    watch(ctx, session.issue!.id, session.id)
    await tell(client, session.id, `chain-plan:${record.run}:${session.id}`, { type: 'thought', body: planText(session.issue!, context, parallel) }, signal)
    ctx.state.set(CHAIN_KEYS.run(session.id), session.issue!.id)
    return
  }
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
  const allowed = mayControl(ctx, prompt.user?.id)
  if (!stop && allowed && isStart(prompt) && record?.status !== 'running' && trigger.meta.delegate === viewer) {
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
  const control = stop ? record?.status === 'running' : isStart(prompt)
  if (control && allowed && stop) {
    await stopChain(ctx, client, epic, record!, 'stop requested in Linear', { id: trigger.actor.id }, signal)
  } else {
    await client.activity(String(trigger.meta.session), stableUuid(`epic-prompt:${String(trigger.meta.activity)}`),
      { type: 'thought', body: control && !allowed ? refusedText(ctx) : statusText(ctx, record, identifier, 'the app') }, false, signal).catch(ignoreGone)
  }
  ctx.state.set(CHAIN_KEYS.run(prompt.id), epic)
  return true
}
const refusedWorkText = 'Only users on the Linear Source\'s allowed list can start work by delegating an Issue to the app.'
const isStart = (prompt: Prompt) => (prompt.content.body ?? '').trim().toLowerCase() === 'start'

/** Why a person's start or stop of a chain was not carried out. */
export const refusedText = (ctx: SourceContext) => ctx.admits
  ? 'Only users on the Linear Source\'s allowed list can start or stop a chain of sub-issues.'
  : 'This dsh-superagent version cannot check the Linear policy, so nobody can start or stop a chain of sub-issues.'
/** Answers a delegation by someone the policy does not admit, once per session. */
export async function refuseDelegation(ctx: SourceContext, client: LinearClient, session: Session, signal: AbortSignal): Promise<void> {
  await tell(client, session.id, `chain-refused:${session.id}`, { type: 'thought', body: refusedText(ctx) }, signal)
  ctx.state.set(CHAIN_KEYS.run(session.id), session.issue!.id)
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
    return `Not working on ${identifier}${record?.reason ? ` (stopped: ${record.reason})` : ''}. To start a chain, delegate the issue to ${app}; if it is delegated already, write exactly "start" in its session.`
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

  const children = chain.children.nodes
  // Linear can close a parent together with its last sub-issue, and may drop its delegate as it does.
  const finished = children.length > 0 && !chain.children.pageInfo.hasNextPage && children.every(child => closed(child.state))
  if (chain.delegate?.id === viewer) record.delegated = true
  else if (record.delegated && !finished) return await stop(`${record.identifier} is no longer delegated to the app`)
  if (closed(chain.state) && !finished) return await stop(`${record.identifier} was ${chain.state!.type}`)
  if (!finished && (chain.children.pageInfo.hasNextPage || children.some(child => child.inverseRelations.pageInfo.hasNextPage))) {
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

  const blockers = (child: Child) => child.inverseRelations.nodes.flatMap(relation => relation.type === 'blocks' ? [relation.issue ?? UNREADABLE_BLOCKER] : [])
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
  const waiting = !running.size && !ready.length ? elsewhere.map(child => child.identifier).join(', ') : ''
  if (waiting && record.waiting !== waiting) {
    await tell(client, record.session, `chain-waiting:${record.run}:${waiting}`, { type: 'thought',
      body: `Waiting for ${waiting}, assigned to someone else; the chain goes on once they close.` }, signal)
    record.waiting = waiting
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
  const built = withParentDocuments(chainTrigger(issue, session, started.url ?? issue.url, epic, record, started.at), issue, context)
  const trigger = placed(ctx, withContext(built, context), where.repository)
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
    const { team, teamKey, issue, identifier, issueUrl, session } = origin.meta
    return { id: `linear:chain-stop:${record.run}:${child}`, source: SOURCE, threads: origin.threads, actor: { source: SOURCE, id: by?.id ?? '' },
      human: !!by, addressed: 'direct', at, text: `Stop requested in Linear.\n\nThe work on the sub-issues of ${record.identifier} stopped: ${reason}.`,
      ...origin.channel ? { channel: origin.channel } : {}, ...origin.url ? { url: origin.url } : {},
      meta: { team, teamKey, issue, identifier, ...issueUrl ? { issueUrl } : {}, session, kind: 'chain-stop', signal: 'stop', chain: epic, ...repository ? { repository } : {} } }
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
  await tell(client, record.session, `chain-stop:${record.run}`, { type: 'response', body: `Stopped: ${reason}.` }, signal)
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
  await tell(client, record.session, `chain-done:${record.run}`, { type: 'response',
    body: `All sub-issues of ${record.identifier} are done.\n\n${lines.join('\n')}` }, signal)
  setActive(ctx, epic, false)
}

/** An Issue the Source saw a session or ticket on: its last session, when, and when Linear created the newest session it read. */
export interface Watch { session?: string; at: string; sessionAt?: string }
export const DELEGATION_OVERLAP_MS = 5000
const watches = (ctx: SourceContext) => ctx.state.get<Record<string, Watch>>(CHAIN_KEYS.watched) ?? {}
export function watch(ctx: SourceContext, issue: string, session?: string, sessionAt?: string): void {
  const all = watches(ctx)
  ctx.state.set(CHAIN_KEYS.watched, { ...all, [issue]: { ...all[issue], ...session ? { session } : {}, ...sessionAt ? { sessionAt } : {}, at: new Date().toISOString() } })
}
function prune(ctx: SourceContext): void {
  const now = Date.now()
  const all = Object.entries(watches(ctx))
  const kept = all.filter(([, entry]) => now - Date.parse(entry.at) < CLOSE_HORIZON_MS)
  if (kept.length !== all.length) ctx.state.set(CHAIN_KEYS.watched, kept.length ? Object.fromEntries(kept) : undefined)
}

/**
 * Handles each Issue a person delegated to the app since the last check, read in one query, when no chain or ticket of its own runs:
 * Linear reuses the Issue's session then, so no new one arrives. One with open sub-issues the Source saw before or has a chain for
 * starts a chain; one without sub-issues starts a run after DELEGATION_GRACE_MS. The check time moves only once every candidate was handled.
 */
export async function followDelegations(ctx: SourceContext, client: LinearClient, config: LinearConfig, viewer: string, round: Round, signal: AbortSignal,
  sessionsTaken = true): Promise<void> {
  prune(ctx)
  const checked = ctx.state.get<string>(CHAIN_KEYS.delegated)
  const now = new Date().toISOString()
  if (!checked) { ctx.state.set(CHAIN_KEYS.delegated, now); return }
  const since = new Date(Date.parse(checked) - DELEGATION_OVERLAP_MS).toISOString()
  let ids: string[]
  try { ids = await client.delegatedIssues(viewer, since, signal) }
  catch (error) { if (signal.aborted) throw error; round.chainFailed++; return }
  let failed = false
  const open = openTickets(ctx)
  for (const issue of ids) {
    if (signal.aborted) throw new Error('The Linear Source stopped during the delegations')
    const record = chainOf(ctx, issue)
    if (record?.status === 'running') continue
    try { await redelegated(ctx, client, issue, viewer, since, config.chainParallel, !open.has(issue) && (!!record || !!watches(ctx)[issue]), signal) }
    catch (error) { if (signal.aborted) throw error; round.chainFailed++; failed = true }
  }
  if (!failed) ctx.state.set(CHAIN_KEYS.delegated, now)
  // A session read that left something out may still hold the session Linear opened for a delegation.
  if (sessionsTaken) await startRedelegations({ ctx, client, config, viewer, round, signal }, open)
}
async function redelegated(ctx: SourceContext, client: LinearClient, issue: string, viewer: string, since: string, parallel: number, known: boolean,
  signal: AbortSignal): Promise<void> {
  // An Issue the Source never knew, or one with an open ticket, can only start a run without sub-issues, so its history is read only then.
  let context = known ? undefined : await client.issueContext(issue, signal)
  if (context?.children.nodes.length) return
  const change = await client.delegation(issue, viewer, since, signal)
  if (!change?.person || ctx.state.get(CHAIN_KEYS.run(change.id))) return
  context ??= await client.issueContext(issue, signal)
  const session = chainOf(ctx, issue)?.session || watches(ctx)[issue]?.session || ''
  if (!context.children.nodes.length) {
    if (mayControl(ctx, change.person.id)) pend(ctx, issue, { change: change.id, at: change.at, person: change.person })
    else {
      await tell(client, session, `delegation-refused:${change.id}`, { type: 'thought', body: refusedWorkText }, signal)
      ctx.state.set(CHAIN_KEYS.run(change.id), issue)
    }
    return
  }
  if (!context.children.nodes.some(child => !closed(child.state))) {
    const details = await client.issue(issue, signal)
    await tell(client, session, `chain-all-done:${change.id}`, { type: 'thought',
      body: `All sub-issues of ${details.identifier} are done; nothing to start. Add an open sub-issue and delegate it again to start a chain.` }, signal)
    ctx.state.set(CHAIN_KEYS.run(change.id), issue)
    return
  }
  if (!mayControl(ctx, change.person.id)) {
    await tell(client, session, `chain-refused:${change.id}`, { type: 'thought', body: refusedText(ctx) }, signal)
    ctx.state.set(CHAIN_KEYS.run(change.id), issue)
    return
  }
  const details = await client.issue(issue, signal)
  await startRun(ctx, client, { run: change.id, session, issue: details, delegator: change.person, delegation: true }, context, viewer, parallel, signal)
}

/** A delegation of an Issue without sub-issues waiting to start a run, with the session made for it once there is one. */
interface Redelegation { change: string; at: string; person: { id: string; name?: string | null }; session?: string; url?: string; identifier?: string; waited?: boolean }
const redelegations = (ctx: SourceContext) => ctx.state.get<Record<string, Redelegation>>(CHAIN_KEYS.redelegations) ?? {}
function pend(ctx: SourceContext, issue: string, entry: Redelegation): void {
  const all = redelegations(ctx)
  if (all[issue]?.change !== entry.change) ctx.state.set(CHAIN_KEYS.redelegations, { ...all, [issue]: entry })
}
function settle(ctx: SourceContext, issue: string, change: string): void {
  ctx.state.set(CHAIN_KEYS.run(change), issue)
  const { [issue]: _, ...rest } = redelegations(ctx)
  ctx.state.set(CHAIN_KEYS.redelegations, Object.keys(rest).length ? rest : undefined)
}
/** Whether Linear opened a session for the delegation itself; both times are Linear's, so the local clock cannot skew it. */
function fresh(ctx: SourceContext, issue: string, entry: Redelegation): boolean {
  const at = watches(ctx)[issue]?.sessionAt
  return !!at && Date.parse(at) >= Date.parse(entry.at) - DELEGATION_OVERLAP_MS
}
async function startRedelegations(env: Env, open: Map<string, Ticket[]>): Promise<void> {
  for (const [issue, entry] of Object.entries(redelegations(env.ctx))) {
    if (env.signal.aborted) throw new Error('The Linear Source stopped during the delegations')
    if (Date.now() - Date.parse(entry.at) < DELEGATION_GRACE_MS) continue
    if (!entry.session && open.has(issue) && !fresh(env.ctx, issue, entry)) {
      if (!entry.waited) env.ctx.state.set(CHAIN_KEYS.redelegations, { ...redelegations(env.ctx), [issue]: { ...entry, waited: true } })
      if (Date.now() - Date.parse(entry.at) < REDELEGATION_GIVE_UP_MS) continue
      console.log(`dsh-superagent-linear: gave up starting ${entry.identifier ?? issue} after ${REDELEGATION_GIVE_UP_MS / 3600_000} hours: its earlier ticket is still open`)
      env.round.chainFailed++
      settle(env.ctx, issue, entry.change)
      continue
    }
    try { await startRedelegation(env, issue, entry, open) }
    catch (error) {
      if (env.signal.aborted) throw error
      if (error instanceof LinearError && error.gone) { settle(env.ctx, issue, entry.change); continue }
      env.round.chainFailed++
      if (Date.now() - Date.parse(entry.at) < REDELEGATION_GIVE_UP_MS) continue
      console.log(`dsh-superagent-linear: gave up starting ${entry.identifier ?? issue} after ${REDELEGATION_GIVE_UP_MS / 3600_000} hours: ${String(error)}`)
      settle(env.ctx, issue, entry.change)
    }
  }
}

export function redelegationTrigger(issue: Issue, session: string, url: string, change: string, person: string, at: string): Trigger {
  return { id: `linear:delegation:${change}`, source: SOURCE, threads: [{ source: SOURCE, id: threadOf(issue.id) }],
    actor: { source: SOURCE, id: person }, human: true, addressed: 'direct', at, text: issueText(issue),
    channel: channel(issue, session, url), url, meta: meta(issue, session, 'session') }
}

/** Starts a re-delegated Issue without sub-issues as a first delegation would, in a session of its own recorded before its Trigger. */
async function startRedelegation(env: Env, issue: string, entry: Redelegation, open: Map<string, Ticket[]>): Promise<void> {
  const { ctx, client, config, viewer, signal } = env
  if (!entry.session && (open.has(issue) || chainOf(ctx, issue)?.status === 'running' || fresh(ctx, issue, entry))) {
    return settle(ctx, issue, entry.change)
  }
  const details = await client.issue(issue, signal)
  // A delegation that waited behind a ticket which closed the Issue must not start a second run on it.
  if (entry.waited && closed(details.state)) {
    if (entry.session) await tell(client, entry.session, `delegation-closed:${entry.change}`,
      { type: 'thought', body: `Not started: ${details.identifier} is ${details.state!.type}.` }, signal)
    return settle(ctx, issue, entry.change)
  }
  if (entry.identifier !== details.identifier) {
    entry.identifier = details.identifier
    ctx.state.set(CHAIN_KEYS.redelegations, { ...redelegations(ctx), [issue]: entry })
  }
  const where = routeOf(ctx, config, redelegationTrigger(details, '', details.url, entry.change, entry.person.id, entry.at))
  if (where.kind !== 'served' || (!entry.session && (details.delegate?.id !== viewer || !mayControl(ctx, entry.person.id)))) {
    if (entry.session) await tell(client, entry.session, `delegation-unserved:${entry.change}`,
      { type: 'error', body: `Not started: ${details.identifier} is no longer in a repository this deployment serves.` }, signal)
    return settle(ctx, issue, entry.change)
  }
  if (!entry.session) {
    const created = await client.createSession(issue, signal)
    addOwnSession(ctx, created.id)
    entry.session = created.id
    entry.url = created.url ?? details.url
    ctx.state.set(CHAIN_KEYS.redelegations, { ...redelegations(ctx), [issue]: entry })
  }
  const session = entry.session
  if (!ctx.state.get(KEYS.seen(session))) {
    await client.activity(session, stableUuid(`seen:${session}`), { type: 'thought', body: 'Received.' }, true, signal).catch(ignoreGone)
    ctx.state.set(KEYS.seen(session), true)
  }
  const context = await client.issueContext(issue, signal).catch((error: unknown) => { if (!signal.aborted) env.round.contextFailed++; throw error })
  if (context.children.nodes.length) {
    await tell(client, session, `delegation-grown:${entry.change}`,
      { type: 'thought', body: `Not started: ${details.identifier} has sub-issues now. Delegate it to the app again to work through them.` }, signal)
    return settle(ctx, issue, entry.change)
  }
  const trigger = withParentDocuments(redelegationTrigger(details, session, entry.url ?? details.url, entry.change, entry.person.id, entry.at), details, context)
  await ctx.receive(placed(ctx, withMode(withContext(trigger, context), context), where.repository))
  watch(ctx, issue, session)
  settle(ctx, issue, entry.change)
}
