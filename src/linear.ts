/** The Linear Source: a Linear agent app's sessions on the listed teams become Triggers, and replies go back as agent activities. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { LinearClient, LinearError, stableUuid, type ActivityContent, type Prompt, type Session } from './linear-api.ts'
import type { OutboundMessage, SourceContext, SourceKind, Trigger } from './types.ts'

export const SOURCE = 'linear'
export const HEALTH = 'linear'
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
export const LinearConfigSchema = z.object({
  clientIdFile: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path').default(''),
  clientSecretFile: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path').default(''),
  teams: z.array(z.object({ id: z.string().trim().default(''), key: z.string().trim().default(''), repository: z.string().trim().regex(REPOSITORY),
    enabled: z.boolean().default(true) }).strict().refine(team => team.id !== '' || team.key !== '', 'A team id or key')).default([]),
  pollSeconds: z.number().int().min(5).max(600).default(10),
  completeOnMerge: z.boolean().default(true),
}).strict()
export type LinearConfig = z.infer<typeof LinearConfigSchema>
type TeamConfig = LinearConfig['teams'][number]

/** A configured team's row in the admission table and its name in health: its key, or its id when it names no key. */
export const teamName = (team: TeamConfig) => team.key || team.id
/** Whether a team entry names Linear team `id` with `key`: by id when the entry has one, as a key can move to another team, else by key ignoring case. */
export const sameTeam = (team: TeamConfig, id: unknown, key: unknown) =>
  team.id !== '' ? team.id === id : team.key.toUpperCase() === String(key ?? '').toUpperCase()
/** The enabled configured team a Trigger's Issue belongs to. */
export function teamOf(config: LinearConfig, meta: Record<string, unknown>): TeamConfig | undefined {
  return config.teams.find(team => team.enabled && sameTeam(team, meta.team, meta.teamKey))
}

export const KEYS = {
  sessions: 'linear-sessions-cursor',
  prompts: 'linear-prompts-cursor',
  seen: (session: string) => `linear-seen:${session}`,
  linked: (session: string, url: string) => `linear-linked:${session}:${url}`,
  completed: (ticket: string) => `linear-completed:${ticket}`,
  followed: 'linear-followed-tickets',
}
const threadOf = (issue: string) => `issue:${issue}`
/** The next cursor: five seconds before the newest item read, for writes Linear records late, and never behind the current one. */
const cursorAfter = (since: string, newest: string | undefined) =>
  newest === undefined ? since : new Date(Math.max(Date.parse(since), Date.parse(newest) - 5000)).toISOString()

type Issue = NonNullable<Session['issue']>
function channel(issue: Issue, session: string, url: string) {
  return { source: SOURCE, thread: `${SOURCE}:${threadOf(issue.id)}`,
    address: { session, issue: issue.id, team: issue.team.id, teamKey: issue.team.key, identifier: issue.identifier, url } }
}
function meta(issue: Issue, session: string, kind: string) {
  return { team: issue.team.id, teamKey: issue.team.key, issue: issue.id, identifier: issue.identifier, session, kind }
}

/** The Trigger of a session a person started by delegating an issue to the app or mentioning it; the app's own sessions produce none. */
export function sessionTrigger(session: Session, viewer: string): Trigger | undefined {
  const issue = session.issue
  if (!issue || session.creator?.id === viewer) return undefined
  const url = session.url ?? issue.url
  const subject = `${issue.identifier}: ${issue.title}`
  const text = session.comment?.body ? `${session.comment.body}\n\n(${subject})` : `${subject}\n\n${issue.description ?? ''}`.trim()
  return { id: `linear:session:${session.id}`, source: SOURCE, threads: [{ source: SOURCE, id: threadOf(issue.id) }],
    actor: { source: SOURCE, id: session.creator?.id ?? '' }, human: !!session.creator, addressed: 'direct', at: session.createdAt, text,
    channel: channel(issue, session.id, url), url, meta: meta(issue, session.id, 'session') }
}
/** The Trigger of a person's prompt in a session; a stop signal says so in its text. */
export function promptTrigger(prompt: Prompt, viewer: string): Trigger | undefined {
  const issue = prompt.agentSession.issue
  if (!issue || !prompt.user || prompt.user.id === viewer) return undefined
  const body = prompt.content.body ?? ''
  const stop = prompt.signal === 'stop'
  return { id: `linear:prompt:${prompt.id}`, source: SOURCE, threads: [{ source: SOURCE, id: threadOf(issue.id) }],
    actor: { source: SOURCE, id: prompt.user.id }, human: true, addressed: 'direct', at: prompt.createdAt,
    text: stop ? `Stop requested in Linear.${body ? `\n\n${body}` : ''}` : body,
    channel: channel(issue, prompt.agentSession.id, issue.url), url: issue.url,
    meta: { ...meta(issue, prompt.agentSession.id, 'prompt'), activity: prompt.id, ...stop ? { signal: 'stop' } : {} } }
}

const CONTENT: Record<OutboundMessage['kind'], ActivityContent['type']> = { acknowledgement: 'thought', reply: 'response', notice: 'thought' }
/** Sends a message as an activity in its session, once per message id. */
export async function sendLinear(client: LinearClient, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { session } = message.channel.address
  if (!session) throw new Error('Missing Linear session')
  try {
    await client.activity(session, stableUuid(`message:${message.id}`), { type: CONTENT[message.kind], body: message.text })
    return 'sent'
  } catch (error) {
    if (error instanceof LinearError && error.gone) return 'gone'
    throw error
  }
}

export function linearKind(client: LinearClient): SourceKind<LinearConfig> {
  return {
    kind: SOURCE,
    title: { zh: 'Linear', en: 'Linear' },
    description: { zh: '接收 Linear 智能体应用在下列团队里的会话：把 Issue 指派给它或 @ 它。', en: 'Receives the Linear agent app\'s sessions on these teams: an Issue delegated to it, or a mention of it.' },
    schema: LinearConfigSchema,
    accountFields: ['clientIdFile', 'clientSecretFile'],
    fields: [
      { key: 'clientIdFile', type: 'text', label: { zh: '应用 client id 文件', en: 'App client id file' } },
      { key: 'clientSecretFile', type: 'text', label: { zh: '应用 client secret 文件', en: 'App client secret file' } },
      { key: 'teams', type: 'rows', label: { zh: '接收的团队', en: 'Teams' }, hint: { zh: '团队 key（例如 ENG）或 id 填一个即可', en: 'A team key, such as ENG, or its id' }, columns: [
        { key: 'key', type: 'text', label: { zh: '团队 key', en: 'Team key' }, optional: true },
        { key: 'id', type: 'text', label: { zh: '团队 id', en: 'Team id' }, optional: true },
        { key: 'repository', type: 'text', label: { zh: '仓库', en: 'Repository' }, pattern: REPOSITORY.source.slice(1, -1) }] },
      { key: 'completeOnMerge', type: 'switch', advanced: true, label: { zh: 'PR 合并后完成 Issue', en: 'Complete the Issue once its pull request merges' } },
      { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    ],
    health: [HEALTH],
    scope({ meta }, config) {
      const team = teamOf(config, meta)
      return team ? { listened: true, observed: false, row: teamName(team) } : { listened: false, reason: 'team_not_listed' }
    },
    channel: {
      allowed: (address, config) => teamOf(config, { team: address.team, teamKey: address.teamKey }) !== undefined,
      send: (_host, message) => sendLinear(client, message),
      link: address => ({ url: address.url ?? '', label: { zh: `Linear ${address.identifier ?? ''}`, en: `Linear ${address.identifier ?? ''}` } }),
    },
    find: query => ({ threads: [], terms: [...new Set(query.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? [])] }),
    policy: {
      schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Linear 用户', en: 'Linear users who may originate work' }, columns: [
        { key: 'id', type: 'text', label: { zh: '用户 id', en: 'User id' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
      explicit: { zh: '名单里的人把 Issue 指派给智能体，或在评论里 @ 它。', en: 'Someone on the list delegates an Issue to the agent, or mentions it in a comment.' },
      unnamed: { person: { zh: 'Linear 用户', en: 'Linear user' }, bot: { zh: 'Linear 应用', en: 'Linear app' } },
      rows: stored => LinearConfigSchema.parse(stored).teams.filter(team => team.enabled).map(team => ({ id: teamName(team), label: teamName(team),
        note: { zh: '仅会话', en: 'Sessions only' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })),
    },
    environment: {
      variables: [
        { key: 'DSH_SUPERAGENT_LINEAR_ISSUE', description: { zh: '接下工单的 Linear Issue 标识，例如 ENG-12；工单不是从 Linear 来的时为空', en: 'Identifier of the Linear Issue that started the ticket, such as ENG-12; empty when the ticket did not start on Linear' } },
        { key: 'DSH_SUPERAGENT_LINEAR_ISSUE_URL', description: { zh: '那个 Linear Issue 的链接', en: 'Link to that Linear Issue' } },
      ],
      values: ({ trigger }) => trigger?.source === SOURCE
        ? { DSH_SUPERAGENT_LINEAR_ISSUE: String(trigger.meta.identifier ?? ''), DSH_SUPERAGENT_LINEAR_ISSUE_URL: trigger.url ?? '' }
        : { DSH_SUPERAGENT_LINEAR_ISSUE: '', DSH_SUPERAGENT_LINEAR_ISSUE_URL: '' },
    },
  }
}

export interface Round { sessions: number; prompts: number; unreadable: number; skipped: string[]; unknown: string[]; misrouted: string[] }

/**
 * One polling round: new sessions, then new prompts, then the pull requests and merges of tickets that started on Linear.
 * A cursor moves only past items that were all taken in; ids make a replay after a failure harmless.
 */
export async function pollLinear(ctx: SourceContext, client: LinearClient, config: LinearConfig, signal: AbortSignal): Promise<Round> {
  const repository = ctx.deployment.repository
  const enabled = config.teams.filter(team => team.enabled)
  const skipped = enabled.filter(team => team.repository !== repository).map(teamName)
  const known = await client.teams(signal)
  const unknown = enabled.filter(team => !known.some(item => sameTeam(team, item.id, item.key))).map(teamName)
  // A listed team whose repository is not the GitHub Source's is left out; an unlisted one goes to receive, whose scope filters it.
  const misrouted = (trigger: Trigger) => { const team = teamOf(config, trigger.meta); return team !== undefined && team.repository !== repository }
  const served = (trigger: Trigger) => teamOf(config, trigger.meta)?.repository === repository
  const viewer = await client.viewer(signal)
  const now = new Date().toISOString()
  const round: Round = { sessions: 0, prompts: 0, unreadable: 0, skipped, unknown, misrouted: [] }
  const sessionsSince = ctx.state.get<string>(KEYS.sessions)
  const promptsSince = ctx.state.get<string>(KEYS.prompts)
  // A first round starts from now: sessions from before the Source was switched on are not work for it.
  if (!sessionsSince || !promptsSince) {
    if (!sessionsSince) ctx.state.set(KEYS.sessions, now)
    if (!promptsSince) ctx.state.set(KEYS.prompts, now)
    return round
  }

  const sessions = await client.sessions(sessionsSince, signal)
  round.unreadable += sessions.unreadable
  let failed = false
  for (const session of sessions.items) {
    if (signal.aborted) throw new Error('The Linear Source stopped during the read')
    const trigger = sessionTrigger(session, viewer)
    if (!trigger) continue
    if (misrouted(trigger)) { round.misrouted.push(String(trigger.meta.identifier)); continue }
    try {
      // Linear marks a session unresponsive when nothing answers within seconds; an evaluation takes longer.
      if (served(trigger) && !ctx.state.get(KEYS.seen(session.id))) {
        await client.activity(session.id, stableUuid(`seen:${session.id}`), { type: 'thought', body: 'Received.' }, true, signal)
          .catch((error: unknown) => { if (!(error instanceof LinearError && error.gone)) throw error })
        ctx.state.set(KEYS.seen(session.id), true)
      }
      await ctx.receive(trigger)
      describe(ctx, trigger)
      round.sessions++
    } catch (error) {
      if (signal.aborted) throw error
      failed = true
    }
  }
  if (!failed) ctx.state.set(KEYS.sessions, cursorAfter(sessionsSince, sessions.items.at(-1)?.createdAt))
  const sessionsFailed = failed

  const prompts = await client.prompts(promptsSince, signal)
  round.unreadable += prompts.unreadable
  failed = false
  for (const prompt of prompts.items) {
    if (signal.aborted) throw new Error('The Linear Source stopped during the read')
    const trigger = promptTrigger(prompt, viewer)
    if (!trigger) continue
    if (misrouted(trigger)) { round.misrouted.push(String(trigger.meta.identifier)); continue }
    try {
      await ctx.receive(trigger)
      round.prompts++
    } catch (error) {
      if (signal.aborted) throw error
      failed = true
    }
  }
  if (!failed) ctx.state.set(KEYS.prompts, cursorAfter(promptsSince, prompts.items.at(-1)?.createdAt))

  await followTickets(ctx, client, config, signal)
  if (failed || sessionsFailed) throw new Error('A Linear session or prompt was not taken in; the next round reads it again')
  return round
}

function describe(ctx: SourceContext, trigger: Trigger): void {
  ctx.threads.describe(`${SOURCE}:${trigger.threads[0]!.id}`, { label: String(trigger.meta.identifier), ...trigger.url ? { url: trigger.url } : {} })
}

/**
 * Links each pull request a ticket that started on Linear follows into its session, and completes the Issue once the ticket's own
 * pull request merged. An ended ticket gets one last look, then is dropped, unless completing its Issue still has to be retried.
 */
async function followTickets(ctx: SourceContext, client: LinearClient, config: LinearConfig, signal: AbortSignal): Promise<void> {
  const open = new Set(ctx.tickets.open().filter(ticket => ctx.triggers.get(ticket.origin.triggerId)?.source === SOURCE).map(ticket => ticket.id))
  const followed = new Set([...ctx.state.get<string[]>(KEYS.followed) ?? [], ...open])
  for (const id of [...followed]) {
    if (signal.aborted) break
    const ticket = ctx.tickets.get(id)
    const origin = ticket && ctx.triggers.get(ticket.origin.triggerId)
    if (!ticket || !origin) { followed.delete(id); continue }
    const session = String(origin.meta.session ?? ''), issue = String(origin.meta.issue ?? '')
    for (const follow of ticket.follows ?? []) {
      if (!follow.thread.startsWith('github:')) continue
      const url = ctx.threads.get(follow.thread)?.meta.url
      if (typeof url === 'string' && url && !ctx.state.get(KEYS.linked(session, url))) {
        await client.addLinks(session, [{ label: `Pull request #${follow.thread.slice('github:'.length)}`, url }], signal)
          .then(() => { ctx.state.set(KEYS.linked(session, url), true) }, () => { /* Retried on the next round. */ })
      }
    }
    const merged = (ticket.follows ?? []).some(follow => follow.own && follow.closed?.outcome === 'merged')
    let pending = false
    if (merged && config.completeOnMerge && !ctx.state.get(KEYS.completed(id))) {
      await client.complete(issue, signal).then(() => { ctx.state.set(KEYS.completed(id), true) }, () => { pending = true })
    }
    if (!open.has(id) && !pending) followed.delete(id)
  }
  ctx.state.set(KEYS.followed, [...followed])
}

/** Reads every `pollSeconds` once setup finished, reporting the Source's health; three failed rounds in a row are an error. */
export async function watchLinear(ctx: SourceContext, client: LinearClient, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(HEALTH, { state: 'paused', detail: 'Waiting for the deployment check' }); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<LinearConfig>(SOURCE)
    const at = new Date().toISOString()
    if (!config) ctx.report(HEALTH, { state: 'paused', detail: 'Off', at })
    else if (!config.clientIdFile || !config.clientSecretFile || !config.teams.some(team => team.enabled)) {
      ctx.report(HEALTH, { state: 'paused', detail: 'Set the app credential files and a team', at })
    } else {
      try {
        const round = await pollLinear(ctx, client, config, signal)
        failures = 0
        const skipped = round.skipped.length ? `; teams ${round.skipped.join(', ')} skipped: their repository is not the GitHub Source's` : ''
        const unknown = round.unknown.length ? `; teams ${round.unknown.join(', ')} not found in Linear` : ''
        const misrouted = round.misrouted.length ? `; left out ${round.misrouted.slice(0, 10).join(', ')}${round.misrouted.length > 10 ? ' and more' : ''}` : ''
        ctx.report(HEALTH, { state: round.skipped.length || round.unknown.length ? 'error' : 'ready', at,
          detail: `${round.sessions} sessions, ${round.prompts} prompts, ${round.unreadable} unreadable${skipped}${misrouted}${unknown}` })
      } catch (error) {
        failures++
        // A refused token or a rate limit needs no three rounds to show: no request can succeed until it passes.
        const blocked = error instanceof LinearError && error.throttled
        if (!signal.aborted && (blocked || failures >= 3)) ctx.report(HEALTH, { state: 'error', at, detail: `${failures} failed polls in a row; last: ${String(error)}` })
      }
    }
    await delay((config?.pollSeconds ?? 10) * 1000, undefined, { signal }).catch(() => {})
  }
}
