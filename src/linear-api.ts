/** A small Linear GraphQL client for an agent app: client-credentials token, agent sessions, prompts and activities. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

/** Every app token of the Daedalus app is requested with this exact scope; another scope string revokes the app's other tokens. */
export const SCOPE = 'read,write,app:assignable,app:mentionable'
const TOKEN_SKEW_MS = 60 * 60_000
const TIMEOUT_MS = 30_000
/** Linear keeps at most 1,000 tokens per app and evicts the least recently used, so this client mints at most one per 15 minutes. */
export const MINT_INTERVAL_MS = 15 * 60_000
export const ENDPOINTS: Endpoints = { tokenUrl: 'https://api.linear.app/oauth/token', apiUrl: 'https://api.linear.app/graphql' }

export class LinearError extends Error {
  constructor(message: string, readonly status?: number, readonly codes: readonly string[] = []) { super(message) }
  /** Linear reports a missing or deleted entity, such as an archived session, this way; a retry cannot succeed. */
  get gone(): boolean { return this.codes.some(code => /not.?found/i.test(code)) || /entity not found|could not find/i.test(this.message) }
  get unauthenticated(): boolean { return this.status === 401 || this.codes.some(code => /authenticat/i.test(code)) }
  get throttled(): boolean { return this.codes.includes('MINT_THROTTLED') || this.codes.includes('RATELIMITED') }
}

export interface Credentials { clientIdFile: string; clientSecretFile: string }
export interface Endpoints { tokenUrl: string; apiUrl: string }
type Fetch = typeof fetch

/** A deterministic UUID in v4 layout from `seed`: Linear accepts client ids only in that layout, so a retried create reuses its id. */
export function stableUuid(seed: string): string {
  const bytes = createHash('sha256').update(`dsh-superagent-linear:${seed}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const User = z.looseObject({ id: z.string(), name: z.string().nullish() })
const Team = z.looseObject({ id: z.string(), key: z.string() })
const Issue = z.looseObject({ id: z.string(), identifier: z.string(), title: z.string(), description: z.string().nullish(), url: z.string(), team: Team,
  delegate: z.looseObject({ id: z.string() }).nullish(), project: z.looseObject({ id: z.string(), name: z.string().nullish() }).nullish(),
  labels: z.looseObject({ nodes: z.array(z.looseObject({ name: z.string() })) }).nullish() })
export const SessionSchema = z.looseObject({
  id: z.string(), createdAt: z.string(), url: z.string().nullish(), creator: User.nullish(), appUser: User.nullish(),
  comment: z.looseObject({ id: z.string(), body: z.string().nullish() }).nullish(), issue: Issue.nullish(),
})
export type Session = z.infer<typeof SessionSchema>
export const PromptSchema = z.looseObject({
  id: z.string(), createdAt: z.string(), signal: z.string().nullish(), content: z.looseObject({ body: z.string().nullish() }),
  user: User.nullish(), agentSession: z.looseObject({ id: z.string(), issue: Issue.nullish() }),
})
export type Prompt = z.infer<typeof PromptSchema>
const PageInfo = z.looseObject({ hasNextPage: z.boolean(), endCursor: z.string().nullish() })
const Page = z.looseObject({ nodes: z.array(z.unknown()), pageInfo: PageInfo })

const ISSUE_FIELDS = 'id identifier title description url team { id key } delegate { id } project { id name } labels { nodes { name } }'
const SESSIONS = `query($after: String) { agentSessions(first: 25, after: $after, orderBy: createdAt) {
  nodes { id createdAt url creator { id name } appUser { id name } comment { id body } issue { ${ISSUE_FIELDS} } }
  pageInfo { hasNextPage endCursor } } }`
const PROMPTS = `query($since: DateTimeOrDuration!, $after: String) {
  agentActivities(first: 25, after: $after, orderBy: createdAt, filter: { type: { eq: "prompt" }, createdAt: { gt: $since } }) {
  nodes { id createdAt signal content { ... on AgentActivityPromptContent { body } } user { id name } agentSession { id issue { ${ISSUE_FIELDS} } } }
  pageInfo { hasNextPage endCursor } } }`
const VIEWER = 'query { viewer { id } }'
const TEAMS = 'query($after: String) { teams(first: 100, after: $after) { nodes { id key } pageInfo { hasNextPage endCursor } } }'
const TEAMS_TTL_MS = 10 * 60_000
const ACTIVITY = 'query($id: String!) { agentActivity(id: $id) { id } }'
const CREATE_ACTIVITY = `mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }`
const ADD_URLS = `mutation($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }`
const ISSUE_STATE = `query($id: String!) { issue(id: $id) { state { type } team { states { nodes { id type position } } } } }`
const ISSUES = 'query($ids: [ID!]) { issues(first: 50, filter: { id: { in: $ids } }) { nodes { id delegate { id } state { type } completedAt canceledAt } } }'
const HISTORY = `query($id: String!) { issue(id: $id) { history(first: 50) { nodes { id createdAt actor { id name } fromDelegate { id } toDelegate { id } } } } }`
const SET_STATE = `mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }`

/** An Issue's delegate, and when it closed (moved to a completed or canceled state), if it is closed. */
export interface IssueStatus { delegate: string | null; closedAt?: string }
export interface Undelegation { id: string; at: string; actor?: { id: string; name?: string | null } }
export interface ActivityContent { type: 'thought' | 'response' | 'error'; body: string }

export class LinearClient {
  private token?: { value: string; expires: number }
  private minted = 0
  private limitedUntil = 0
  private viewerId?: string
  private teamList?: { items: { id: string; key: string }[]; until: number }
  constructor(private readonly credentials: () => Credentials, private readonly endpoints: Endpoints = ENDPOINTS, private readonly fetcher: Fetch = fetch) {}

  /** Requests an app token with the fixed scope; the request body is written out by hand so the scope reaches Linear byte for byte. */
  private async mint(signal?: AbortSignal): Promise<string> {
    const wait = this.minted + MINT_INTERVAL_MS - Date.now()
    if (wait > 0) throw new LinearError(`Linear refused the token minted ${Math.round((Date.now() - this.minted) / 60_000)} min ago; the next token request waits ${Math.ceil(wait / 60_000)} min`, 401, ['MINT_THROTTLED'])
    this.minted = Date.now()
    const { clientIdFile, clientSecretFile } = this.credentials()
    let id: string, secret: string
    try {
      id = readFileSync(clientIdFile, 'utf8').trim()
      secret = readFileSync(clientSecretFile, 'utf8').trim()
    } catch { throw new LinearError('The Linear app credential files are not readable') }
    const response = await this.fetcher(this.endpoints.tokenUrl, { method: 'POST', signal: withTimeout(signal),
      headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&scope=${SCOPE}` })
    if (!response.ok) throw new LinearError(`The Linear token endpoint answered ${response.status}`, response.status)
    const body = z.looseObject({ access_token: z.string().min(1), expires_in: z.number().optional() }).parse(await response.json())
    this.token = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 30 * 86_400) * 1000 - TOKEN_SKEW_MS }
    return body.access_token
  }
  private async bearer(signal?: AbortSignal): Promise<string> {
    return this.token && Date.now() < this.token.expires ? this.token.value : await this.mint(signal)
  }

  /** Runs a GraphQL request, minting a new token once when Linear no longer accepts the cached one. */
  async request<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    try { return await this.once<T>(query, variables, signal) }
    catch (error) {
      if (!(error instanceof LinearError) || !error.unauthenticated) throw error
      this.token = undefined
      return await this.once<T>(query, variables, signal)
    }
  }
  private async once<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (Date.now() < this.limitedUntil) throw new LinearError(`Linear's rate limit holds requests until ${new Date(this.limitedUntil).toISOString()}`, 429, ['RATELIMITED'])
    const token = await this.bearer(signal)
    const response = await this.fetcher(this.endpoints.apiUrl, { method: 'POST', signal: withTimeout(signal),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })
    const body = await response.json().catch(() => ({})) as { data?: T; errors?: { message?: string; extensions?: { code?: string; type?: string } }[] }
    const codes = (body.errors ?? []).flatMap(error => [error.extensions?.code, error.extensions?.type].filter((code): code is string => !!code))
    if (response.status === 429 || codes.includes('RATELIMITED')) {
      const reset = Number(response.headers.get('x-ratelimit-requests-reset') ?? response.headers.get('x-ratelimit-endpoint-requests-reset'))
      this.limitedUntil = Number.isFinite(reset) && reset > Date.now() ? Math.min(reset, Date.now() + 3_600_000) : Date.now() + 60_000
      throw new LinearError('Linear rate-limited this app', response.status, [...new Set([...codes, 'RATELIMITED'])])
    }
    if (!response.ok) throw new LinearError(body.errors?.[0]?.message ?? `Linear answered ${response.status}`, response.status, codes)
    if (body.errors?.length) throw new LinearError(body.errors.map(error => error.message ?? 'error').join('; '), response.status, codes)
    if (body.data === undefined) throw new LinearError('Linear answered without data', response.status)
    return body.data
  }

  /** The app user the token acts as, whose own sessions and activities never become Triggers. */
  async viewer(signal?: AbortSignal): Promise<string> {
    this.viewerId ??= z.object({ viewer: z.object({ id: z.string() }) }).parse(await this.request(VIEWER, {}, signal)).viewer.id
    return this.viewerId
  }
  /** The workspace's teams the token can see, read again every ten minutes, to resolve configured keys and report unknown ones. */
  async teams(signal?: AbortSignal): Promise<{ id: string; key: string }[]> {
    if (this.teamList && Date.now() < this.teamList.until) return this.teamList.items
    const items: { id: string; key: string }[] = []
    let after: string | undefined
    for (let pages = 0; pages < 10; pages++) {
      const page = Page.parse((await this.request<Record<string, unknown>>(TEAMS, { after }, signal)).teams)
      for (const node of page.nodes) { const team = Team.safeParse(node); if (team.success) items.push({ id: team.data.id, key: team.data.key }) }
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break
      after = page.pageInfo.endCursor
    }
    this.teamList = { items, until: Date.now() + TEAMS_TTL_MS }
    return items
  }
  /** Sessions created after `since`, oldest first, with the number of nodes that did not parse. */
  async sessions(since: string, signal?: AbortSignal): Promise<{ items: Session[]; unreadable: number }> {
    return await this.collect(SESSIONS, {}, 'agentSessions', SessionSchema, since, signal)
  }
  /** Prompts people wrote into sessions after `since`, oldest first. */
  async prompts(since: string, signal?: AbortSignal): Promise<{ items: Prompt[]; unreadable: number }> {
    return await this.collect(PROMPTS, { since }, 'agentActivities', PromptSchema, since, signal)
  }
  /**
   * Reads pages newest first, as Linear sorts by default, until one reaches `since` or none follows; a page that comes oldest
   * first is read to its end instead, so either direction finds every item after `since`.
   */
  private async collect<S extends z.ZodType<{ createdAt: string }>>(query: string, variables: Record<string, unknown>, field: string, schema: S,
    since: string, signal?: AbortSignal): Promise<{ items: z.infer<S>[]; unreadable: number }> {
    const items: z.infer<S>[] = []
    let unreadable = 0, after: string | undefined
    for (let pages = 0; pages < 10; pages++) {
      const page = Page.parse((await this.request<Record<string, unknown>>(query, { ...variables, after }, signal))[field])
      let reached = false
      const dates = page.nodes.map(node => Date.parse(String((node as { createdAt?: unknown }).createdAt ?? '')))
      const ascending = dates.length > 1 && dates[0]! < dates.at(-1)!
      for (const node of page.nodes) {
        const parsed = schema.safeParse(node)
        if (!parsed.success) { unreadable++; continue }
        if (Date.parse(parsed.data.createdAt) > Date.parse(since)) items.push(parsed.data)
        else if (!ascending) reached = true
      }
      if (reached || !page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break
      after = page.pageInfo.endCursor
    }
    return { items: items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)), unreadable }
  }
  /** Publishes an activity once per `id`: a create that failed after Linear stored it is found again by its id. */
  async activity(session: string, id: string, content: ActivityContent, ephemeral = false, signal?: AbortSignal): Promise<void> {
    try { await this.request(CREATE_ACTIVITY, { input: { id, agentSessionId: session, content, ...ephemeral ? { ephemeral } : {} } }, signal) }
    catch (error) {
      if (error instanceof LinearError && error.gone) throw error
      const found = await this.request<{ agentActivity?: { id: string } | null }>(ACTIVITY, { id }, signal).catch(() => undefined)
      if (!found?.agentActivity) throw error
    }
  }
  /** Adds links, such as the ticket's pull request, to the session's external links. */
  async addLinks(session: string, links: { label: string; url: string }[], signal?: AbortSignal): Promise<void> {
    await this.request(ADD_URLS, { id: session, input: { addedExternalUrls: links } }, signal)
  }
  /** The delegate of each issue Linear still has, by issue id, null when none is delegated; a chunk of 50 that fails is left out. */
  /** Each Issue's delegate and close, 50 Issues a request; a chunk that cannot be read is left out. */
  async issues(ids: string[], signal?: AbortSignal): Promise<Map<string, IssueStatus>> {
    const issues = new Map<string, IssueStatus>()
    const schema = z.object({ issues: z.object({ nodes: z.array(z.object({ id: z.string(), delegate: z.object({ id: z.string() }).nullish(),
      state: z.object({ type: z.string() }).nullish(), completedAt: z.string().nullish(), canceledAt: z.string().nullish() })) }) })
    for (let start = 0; start < ids.length; start += 50) {
      try {
        const data = schema.parse(await this.request(ISSUES, { ids: ids.slice(start, start + 50) }, signal))
        for (const node of data.issues.nodes) {
          const closed = node.state?.type === 'completed' || node.state?.type === 'canceled'
          issues.set(node.id, { delegate: node.delegate?.id ?? null,
            ...closed ? { closedAt: (node.state!.type === 'completed' ? node.completedAt : node.canceledAt) ?? new Date().toISOString() } : {} })
        }
      } catch (error) { if (signal?.aborted) throw error }
    }
    return issues
  }
  /** The newest of the issue's last 50 changes, made at or after `since`, that took its delegation away from `agent`. */
  async undelegation(issue: string, agent: string, since: string, signal?: AbortSignal): Promise<Undelegation | undefined> {
    const entry = z.looseObject({ id: z.string(), createdAt: z.string(), actor: User.nullish(), fromDelegate: z.object({ id: z.string() }).nullish(),
      toDelegate: z.object({ id: z.string() }).nullish() })
    const data = z.object({ issue: z.object({ history: z.object({ nodes: z.array(entry) }) }) }).parse(await this.request(HISTORY, { id: issue }, signal))
    const change = data.issue.history.nodes
      .filter(node => node.fromDelegate?.id === agent && node.toDelegate?.id !== agent && Date.parse(node.createdAt) >= Date.parse(since))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
    return change && { id: change.id, at: change.createdAt, ...change.actor ? { actor: { id: change.actor.id, name: change.actor.name } } : {} }
  }
  /** Moves the issue to its team's first completed state unless it is completed or canceled already. */
  async complete(issue: string, signal?: AbortSignal): Promise<boolean> {
    const data = z.object({ issue: z.object({ state: z.object({ type: z.string() }),
      team: z.object({ states: z.object({ nodes: z.array(z.object({ id: z.string(), type: z.string(), position: z.number() })) }) }) }) })
      .parse(await this.request(ISSUE_STATE, { id: issue }, signal))
    if (data.issue.state.type === 'completed' || data.issue.state.type === 'canceled') return false
    const done = data.issue.team.states.nodes.filter(state => state.type === 'completed').sort((a, b) => a.position - b.position)[0]
    if (!done) return false
    await this.request(SET_STATE, { id: issue, state: done.id }, signal)
    return true
  }
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
}
