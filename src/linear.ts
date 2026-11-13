/** The Linear Source: a Linear agent app's sessions on the listed teams become Triggers, and replies go back as agent activities. */
import { z } from 'zod'
import { LinearClient, LinearError, stableUuid, type ActivityContent, type IssueStatus, type Prompt, type Session, type Undelegation } from './linear-api.ts'
import type { OutboundMessage, SourceContext, SourceKind, Trigger } from './types.ts'
import { Waker } from './webhook.ts'

export const SOURCE = 'linear'
export const HEALTH = 'linear'
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
export const LinearConfigSchema = z.object({
  clientIdFile: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path').default(''),
  clientSecretFile: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path').default(''),
  webhookSecretFile: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path').default(''),
  teams: z.array(z.object({ id: z.string().trim().default(''), key: z.string().trim().default(''),
    repository: z.union([z.literal(''), z.string().trim().regex(REPOSITORY)]).default(''),
    projects: z.array(z.object({ id: z.string().trim().default(''), name: z.string().trim().default(''), repository: z.string().trim().regex(REPOSITORY) })
      .strict().refine(project => project.id !== '' || project.name !== '', 'A project id or name')).default([]),
    enabled: z.boolean().default(true) }).strict().refine(team => team.id !== '' || team.key !== '', 'A team id or key')
    .refine(team => team.repository !== '' || team.projects.length > 0, 'A repository or projects')).default([]),
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
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
/** The deployment's canonical name for `repository`, or undefined when the GitHub Source does not serve it. */
export function servedRepository(deployment: SourceContext['deployment'], repository: string): string | undefined {
  return (deployment.repositories ?? [deployment.repository]).find(name => sameName(name, repository))
}
type ProjectConfig = TeamConfig['projects'][number]
/** The project entry an Issue's project matches: by id, else by name ignoring case for an entry that names no id. */
export function projectOf(team: TeamConfig, project: { id?: unknown; name?: unknown }): ProjectConfig | undefined {
  return team.projects.find(entry => entry.id !== '' && entry.id === project.id)
    ?? team.projects.find(entry => entry.id === '' && sameName(entry.name, String(project.name ?? '')))
}
/** The repository an Issue of `team` works in: its project's, else the team's; undefined when neither names one. */
export function repositoryFor(team: TeamConfig, meta: Record<string, unknown>): string | undefined {
  const project = meta.project ? projectOf(team, { id: meta.project, name: meta.projectName }) : undefined
  return project?.repository || team.repository || undefined
}
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
  delegation: 'linear-delegation',
  delegationChecked: 'linear-delegation-checked',
  closing: 'linear-closing-tickets',
}
export const DELEGATION_INTERVAL_MS = 30_000
/** How long after a ticket ended the Issue it started on is still watched for its close. */
export const CLOSE_HORIZON_MS = 14 * 24 * 3600_000
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
  return { team: issue.team.id, teamKey: issue.team.key, issue: issue.id, identifier: issue.identifier, session, kind,
    ...issue.project ? { project: issue.project.id, ...issue.project.name ? { projectName: issue.project.name } : {} } : {},
    ...issue.delegate ? { delegate: issue.delegate.id } : {}, ...issue.labels?.nodes.length ? { labels: issue.labels.nodes.map(label => label.name) } : {} }
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

/** The stop Trigger for a ticket whose Issue is no longer delegated to the app, from the change that removed it when the history has it. */
export function undelegationTrigger(origin: Trigger, ticket: string, change: Undelegation | undefined, observed: string, repository?: string): Trigger {
  const { team, teamKey, issue, identifier, session } = origin.meta
  const who = change?.actor?.name ?? 'Someone'
  return { id: change ? `linear:undelegated:${change.id}` : `linear:undelegated:${ticket}:${observed}`, source: SOURCE, threads: origin.threads,
    actor: { source: SOURCE, id: change?.actor?.id ?? '' }, human: !!change?.actor, addressed: 'direct', at: change?.at ?? observed,
    text: `Stop requested in Linear.\n\n${who} removed the app as the delegate of ${String(identifier)}.`,
    ...origin.channel ? { channel: origin.channel } : {}, ...origin.url ? { url: origin.url } : {},
    meta: { team, teamKey, issue, identifier, session, kind: 'undelegated', ...change ? { history: change.id } : {}, signal: 'stop',
      ...repository ? { repository } : {} } }
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
    accountFields: ['clientIdFile', 'clientSecretFile', 'webhookSecretFile'],
    fields: [
      { key: 'clientIdFile', type: 'text', label: { zh: '应用 client id 文件', en: 'App client id file' } },
      { key: 'clientSecretFile', type: 'text', label: { zh: '应用 client secret 文件', en: 'App client secret file' } },
      { key: 'webhookSecretFile', type: 'text', optional: true, label: { zh: 'Webhook 签名密钥文件', en: 'Webhook signing secret file' }, hint: { zh: '留空则只轮询；填写后 /hooks/linear 收到的投递会立即触发轮询', en: 'Empty polls only; when set, deliveries to /hooks/linear wake the polling at once' } },
      { key: 'teams', type: 'rows', label: { zh: '接收的团队', en: 'Teams' }, hint: { zh: '团队 key（例如 ENG）或 id 填一个即可', en: 'A team key, such as ENG, or its id' }, columns: [
        { key: 'key', type: 'text', label: { zh: '团队 key', en: 'Team key' }, optional: true },
        { key: 'id', type: 'text', label: { zh: '团队 id', en: 'Team id' }, optional: true },
        { key: 'repository', type: 'text', label: { zh: '仓库', en: 'Repository' }, pattern: REPOSITORY.source.slice(1, -1), optional: true }] },
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

export interface Round { sessions: number; prompts: number; unreadable: number; skipped: string[]; unknown: string[]; misrouted: string[]; unmapped: string[]; unverified: boolean }

/**
 * One polling round: new sessions, then new prompts, then the pull requests and merges of tickets that started on Linear.
 * A cursor moves only past items that were all taken in; ids make a replay after a failure harmless.
 */
export async function pollLinear(ctx: SourceContext, client: LinearClient, config: LinearConfig, signal: AbortSignal): Promise<Round> {
  const enabled = config.teams.filter(team => team.enabled)
  const skipped = enabled.flatMap(team => [
    ...team.repository && !servedRepository(ctx.deployment, team.repository) ? [teamName(team)] : [],
    ...team.projects.filter(project => !servedRepository(ctx.deployment, project.repository)).map(project => `${teamName(team)}/${project.name || project.id}`)])
  // Intake does not need the team list; without it the teams are only left unverified.
  const known = await client.teams(signal).catch((error: unknown) => { if (signal.aborted) throw error; return undefined })
  const unknown = known ? enabled.filter(team => !known.some(item => sameTeam(team, item.id, item.key))).map(teamName) : []
  // A listed team's Issue without a repository, or whose repository the GitHub Source does not serve, is left out; an unlisted team's goes to
  // receive, whose scope filters it.
  const route = (trigger: Trigger): { kind: 'unlisted' | 'unmapped' | 'misrouted' } | { kind: 'served'; repository: string } => {
    const team = teamOf(config, trigger.meta)
    if (!team) return { kind: 'unlisted' }
    const named = repositoryFor(team, trigger.meta)
    if (!named) return { kind: 'unmapped' }
    const repository = servedRepository(ctx.deployment, named)
    return repository ? { kind: 'served', repository } : { kind: 'misrouted' }
  }
  const placed = (trigger: Trigger, repository: string | undefined): Trigger =>
    repository && !sameName(repository, ctx.deployment.repository) ? { ...trigger, meta: { ...trigger.meta, repository } } : trigger
  // A prompt on an Issue with an open ticket follows that ticket, wherever the Issue has moved since.
  const openTicketOf = (issue: string) => {
    for (const ticket of ctx.tickets.open()) {
      const origin = ctx.triggers.get(ticket.origin.triggerId)
      if (origin?.source === SOURCE && origin.meta.issue === issue) return { ticket, origin }
    }
    return undefined
  }
  const viewer = await client.viewer(signal)
  const now = new Date().toISOString()
  const round: Round = { sessions: 0, prompts: 0, unreadable: 0, skipped, unknown, misrouted: [], unmapped: [], unverified: !known }
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
    const found = sessionTrigger(session, viewer)
    if (!found) continue
    const where = route(found)
    if (where.kind === 'misrouted') { round.misrouted.push(String(found.meta.identifier)); continue }
    const trigger = placed(found, where.kind === 'served' ? where.repository : undefined)
    try {
      if (where.kind === 'unmapped') {
        round.unmapped.push(String(found.meta.identifier))
        if (!ctx.state.get(KEYS.seen(session.id))) {
          await client.activity(session.id, stableUuid(`unmapped:${session.id}`), { type: 'error', body: unmappedText(found) }, false, signal)
            .catch((error: unknown) => { if (!(error instanceof LinearError && error.gone)) throw error })
          ctx.state.set(KEYS.seen(session.id), true)
        }
        continue
      }
      // Linear marks a session unresponsive when nothing answers within seconds; an evaluation takes longer.
      if (where.kind === 'served' && !ctx.state.get(KEYS.seen(session.id))) {
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
    const found = promptTrigger(prompt, viewer)
    if (!found) continue
    const open = openTicketOf(String(found.meta.issue))
    let trigger: Trigger
    if (open) {
      const { team, teamKey } = open.origin.meta
      trigger = placed({ ...found, meta: { ...found.meta, team, teamKey } }, open.ticket.execution?.repository ?? repositoryMeta(open.origin))
    } else {
      const where = route(found)
      if (where.kind === 'misrouted') { round.misrouted.push(String(found.meta.identifier)); continue }
      if (where.kind === 'unmapped') { round.unmapped.push(String(found.meta.identifier)); continue }
      trigger = placed(found, where.kind === 'served' ? where.repository : undefined)
    }
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
  await followIssues(ctx, client, viewer, signal)
  if (failed || sessionsFailed) throw new Error('A Linear session or prompt was not taken in; the next round reads it again')
  return round
}

function unmappedText(trigger: Trigger): string {
  const project = trigger.meta.projectName ?? trigger.meta.project
  return `Not taken in: team ${String(trigger.meta.teamKey)} names no repository ${project ? `for project ${String(project)}` : 'for Issues without a project'}.`
}

function describe(ctx: SourceContext, trigger: Trigger): void {
  ctx.threads.describe(`${SOURCE}:${trigger.threads[0]!.id}`, { label: String(trigger.meta.identifier), ...trigger.url ? { url: trigger.url } : {} })
}

/** The repository and number of a GitHub Thread key: `github:12` in the primary, `github:owner/name#12` in another. */
export function pullOf(thread: string, primary: string): { repository: string; number: string } | undefined {
  const match = /^github:(?:([^/#]+\/[^/#]+)#)?(\d+)$/.exec(thread)
  return match ? { repository: match[1] ?? primary, number: match[2]! } : undefined
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
    const own = ticket.execution?.repository ?? repositoryMeta(origin) ?? ctx.deployment.repository
    for (const follow of ticket.follows ?? []) {
      const pull = pullOf(follow.thread, ctx.deployment.repository)
      if (!pull) continue
      const url = ctx.threads.get(follow.thread)?.meta.url
      if (typeof url === 'string' && url && !ctx.state.get(KEYS.linked(session, url))) {
        const label = sameName(pull.repository, own) ? `Pull request #${pull.number}` : `Pull request ${pull.repository}#${pull.number}`
        await client.addLinks(session, [{ label, url }], signal)
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

const repositoryMeta = (trigger: Trigger) => typeof trigger.meta.repository === 'string' && trigger.meta.repository ? trigger.meta.repository : undefined
interface Delegation { delegated: boolean; observed?: string }
/**
 * Reads, at most every 30 seconds and in one batch, the Issues of open tickets that started on Linear and of those tickets
 * whose Issue is not yet known to be closed: stops each open ticket whose Issue was delegated to the app and no longer is, and
 * reports each Issue that moved to a completed or canceled state.
 */
async function followIssues(ctx: SourceContext, client: LinearClient, viewer: string, signal: AbortSignal): Promise<void> {
  const running = ctx.tickets.open().flatMap(ticket => {
    const origin = ctx.triggers.get(ticket.origin.triggerId)
    return origin?.source === SOURCE && typeof origin.meta.issue === 'string' ? [{ ticket, origin, issue: origin.meta.issue }] : []
  })
  // Taken every round, so a ticket that ends between two reads is still watched for its Issue's close.
  const closing = closingTickets(ctx, running.map(item => item.ticket.id))
  const checked = ctx.state.get<string>(KEYS.delegationChecked)
  if (checked && Date.now() - Date.parse(checked) < DELEGATION_INTERVAL_MS) return
  const known = ctx.state.get<Record<string, Delegation>>(KEYS.delegation) ?? {}
  if (!running.length && Object.keys(known).length) ctx.state.set(KEYS.delegation, {})
  if (!running.length && !closing.length) return
  const now = new Date().toISOString()
  ctx.state.set(KEYS.delegationChecked, now)
  const issues = await client.issues([...new Set([...running, ...closing].map(item => item.issue))], signal)
  reportClosed(ctx, closing, issues)
  if (!running.length) return
  const next: Record<string, Delegation> = Object.fromEntries(running.map(({ ticket, origin }) =>
    [ticket.id, known[ticket.id] ?? { delegated: origin.meta.delegate === viewer }]))
  for (const { ticket, origin, issue } of running) {
    const status = issues.get(issue)
    if (signal.aborted || !status) continue
    const before = next[ticket.id]!
    if (status.delegate === viewer) { next[ticket.id] = { delegated: true }; continue }
    if (!before.delegated) continue
    // Saved before the Trigger, so a replay after a crash builds the same fallback id.
    const observed = before.observed ?? now
    next[ticket.id] = { delegated: true, observed }
    ctx.state.set(KEYS.delegation, next)
    const change = await client.undelegation(issue, viewer, origin.at, signal).catch((error: unknown) => { if (signal.aborted) throw error; return undefined })
    try {
      await ctx.receive(undelegationTrigger(origin, ticket.id, change, observed, ticket.execution?.repository ?? repositoryMeta(origin)))
      next[ticket.id] = { delegated: false }
    } catch (error) { if (signal.aborted) throw error }
  }
  ctx.state.set(KEYS.delegation, next)
}
/**
 * The tickets that started on Linear whose Issue is not known to be closed, open ones and those that ended within
 * `CLOSE_HORIZON_MS`, with their Issues; none on a host that cannot take an Issue's close.
 */
function closingTickets(ctx: SourceContext, open: string[]): { id: string; issue: string }[] {
  if (!ctx.tickets.issueClosed) return []
  const ids = new Set([...ctx.state.get<string[]>(KEYS.closing) ?? [], ...open])
  const closing = [...ids].flatMap(id => {
    const ticket = ctx.tickets.get(id)
    const origin = ticket && !ticket.issueClosed ? ctx.triggers.get(ticket.origin.triggerId) : undefined
    const recent = !ticket?.ended || Date.now() - Date.parse(ticket.ended.at) < CLOSE_HORIZON_MS
    return origin?.source === SOURCE && typeof origin.meta.issue === 'string' && recent ? [{ id, issue: origin.meta.issue }] : []
  })
  const kept = closing.map(item => item.id)
  if (kept.join() !== (ctx.state.get<string[]>(KEYS.closing) ?? []).join()) ctx.state.set(KEYS.closing, kept.length ? kept : undefined)
  return closing
}
function reportClosed(ctx: SourceContext, closing: { id: string; issue: string }[], issues: Map<string, IssueStatus>): void {
  const closed = closing.filter(item => issues.get(item.issue)?.closedAt !== undefined)
  for (const { id, issue } of closed) ctx.tickets.issueClosed!(id, issues.get(issue)!.closedAt!)
  if (closed.length) ctx.state.set(KEYS.closing, closing.filter(item => !closed.includes(item)).map(item => item.id))
}

/** Reads every `pollSeconds` once setup finished, reporting the Source's health; three failed rounds in a row are an error. */
export async function watchLinear(ctx: SourceContext, client: LinearClient, signal: AbortSignal, waker = new Waker()): Promise<void> {
  let last = ''
  const report = (health: Parameters<SourceContext['report']>[1]) => {
    ctx.report(HEALTH, health)
    const line = `${health.state}: ${health.detail ?? ''}`
    if (line !== last) { last = line; console.log(`dsh-superagent-linear: ${line}`) }
  }
  await ctx.ready
  if (!ctx.configured()) { report({ state: 'paused', detail: 'Waiting for the deployment check' }); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<LinearConfig>(SOURCE)
    const at = new Date().toISOString()
    if (!config) report({ state: 'paused', detail: 'Off', at })
    else if (!config.clientIdFile || !config.clientSecretFile || !config.teams.some(team => team.enabled)) {
      report({ state: 'paused', detail: 'Set the app credential files and a team', at })
    } else {
      try {
        const round = await pollLinear(ctx, client, config, signal)
        failures = 0
        const skipped = round.skipped.length ? `; teams ${round.skipped.join(', ')} skipped: their repository is not one the GitHub Source serves` : ''
        const unknown = round.unknown.length ? `; teams ${round.unknown.join(', ')} not found in Linear` : round.unverified ? '; teams unverified: Linear\'s team list was not readable' : ''
        const list = (items: string[]) => `${items.slice(0, 10).join(', ')}${items.length > 10 ? ' and more' : ''}`
        const misrouted = round.misrouted.length ? `; left out ${list(round.misrouted)}` : ''
        const unmapped = round.unmapped.length ? `; no repository for ${list(round.unmapped)}: map their project or give the team a repository` : ''
        report({ state: round.skipped.length || round.unknown.length ? 'error' : 'ready', at,
          detail: `${round.sessions} sessions, ${round.prompts} prompts, ${round.unreadable} unreadable${skipped}${misrouted}${unmapped}${unknown}` })
      } catch (error) {
        failures++
        if (!signal.aborted) console.log(`dsh-superagent-linear: poll failed (${failures} in a row): ${String(error)}`)
        // A refused token or a rate limit needs no three rounds to show: no request can succeed until it passes.
        const blocked = error instanceof LinearError && error.throttled
        if (!signal.aborted && (blocked || failures >= 3)) report({ state: 'error', at, detail: `${failures} failed polls in a row; last: ${String(error)}` })
      }
    }
    await waker.wait((config?.pollSeconds ?? 10) * 1000, signal)
  }
}
