/** The Linear Source against a stubbed Linear: token, translation, polling, replies and the tickets' pull requests. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { LinearClient, MINT_INTERVAL_MS, SCOPE, stableUuid, type Prompt, type Session } from '../src/linear-api.ts'
import { DELEGATION_INTERVAL_MS, KEYS, LinearConfigSchema, pullOf, undelegationTrigger, linearKind, pollLinear, promptTrigger, sendLinear, sessionTrigger, watchLinear, type LinearConfig } from '../src/linear.ts'
import { apply } from '../src/index.ts'
import type { OutboundMessage, SourceContext, Ticket, Trigger } from '../src/types.ts'

const VIEWER = 'app-user', OWNER = 'owner-1', TEAM = 'team-web', OTHER_TEAM = 'team-ops'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linear-'))
  writeFileSync(join(dir, 'client-id'), 'client\n'); writeFileSync(join(dir, 'client-secret'), 'secret\n')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const config = (overrides: Partial<z.input<typeof LinearConfigSchema>> = {}): LinearConfig => LinearConfigSchema.parse({
  clientIdFile: join(dir, 'client-id'), clientSecretFile: join(dir, 'client-secret'),
  teams: [{ key: 'WEB', repository: 'acme/widgets' }, { key: 'OPS', repository: 'acme/other' }], ...overrides })
const KEYS_OF: Record<string, string> = { [TEAM]: 'WEB', [OTHER_TEAM]: 'OPS', elsewhere: 'ELSE' }
const issue = (team = TEAM, n = 1) => ({ id: `issue-${n}`, identifier: `${KEYS_OF[team]}-${n}`, title: 'Fix the footer', description: 'It overlaps.',
  url: `https://linear.app/x/issue/WEB-${n}`, team: { id: team, key: KEYS_OF[team]! } })
const session = (id: string, at: string, fields: Partial<Session> = {}): Session => ({ id, createdAt: at, url: `https://linear.app/x/session/${id}`,
  creator: { id: OWNER, name: 'Owner' }, appUser: { id: VIEWER }, comment: null, issue: issue(), ...fields })
const prompt = (id: string, at: string, fields: Partial<Prompt> = {}): Prompt => ({ id, createdAt: at, signal: null, content: { body: 'Also the header' },
  user: { id: OWNER, name: 'Owner' }, agentSession: { id: 's1', issue: issue() }, ...fields })

/** A stand-in Linear: the token endpoint and GraphQL by the operation each request names. */
function linear(handlers: Record<string, (variables: Record<string, unknown>) => unknown> = {}) {
  const calls: { url: string; init: RequestInit; query?: string; variables?: Record<string, unknown> }[] = []
  let token = 0, limited = 0
  const valid = new Set<string>()
  const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url)
    if (target.endsWith('/oauth/token')) {
      calls.push({ url: target, init })
      const value = `token-${++token}`
      valid.add(value)
      return Response.json({ access_token: value, expires_in: 30 * 86_400 })
    }
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> }
    calls.push({ url: target, init, query, variables })
    if (limited) return Response.json({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }, { status: 400, headers: { 'x-ratelimit-requests-reset': String(limited) } })
    const bearer = String((init.headers as Record<string, string>).authorization).slice('Bearer '.length)
    if (!valid.has(bearer)) return Response.json({ errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] }, { status: 401 })
    const operation = Object.keys(handlers).find(name => query.includes(name))
    if (query.includes('viewer') && !operation) return Response.json({ data: { viewer: { id: VIEWER } } })
    if (query.includes('teams(') && !operation) return Response.json({ data: { teams: page(Object.entries(KEYS_OF).map(([id, key]) => ({ id, key }))) } })
    if (query.includes('teams(') && operation === 'teams(') return Response.json({ errors: [{ message: 'Internal error' }] })
    if (!operation) return Response.json({ errors: [{ message: `unexpected ${query.slice(0, 40)}` }] })
    try { return Response.json({ data: handlers[operation]!(variables) }) }
    catch (error) { return Response.json({ errors: [{ message: String((error as Error).message), extensions: { code: (error as { code?: string }).code } }] }) }
  })
  const client = new LinearClient(() => config(), { tokenUrl: 'https://linear.test/oauth/token', apiUrl: 'https://linear.test/graphql' }, fetcher as typeof fetch)
  return { client, fetcher, calls, revoke: () => valid.clear(), limit: (reset: number) => { limited = reset } }
}
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })

/** A SourceContext over plain maps, as dsh-superagent's would behave for this Source. */
function context(fields: { tickets?: Ticket[]; triggers?: Trigger[]; threads?: Record<string, Record<string, unknown>>; repositories?: string[] } = {}) {
  const state = new Map<string, unknown>()
  const received: Trigger[] = []
  const triggers = new Map((fields.triggers ?? []).map(trigger => [trigger.id, trigger]))
  const receive = vi.fn(async (trigger: Trigger) => { received.push(trigger); triggers.set(trigger.id, trigger); return 'stored' })
  const ctx: SourceContext = {
    deployment: { repository: 'acme/widgets', ...fields.repositories ? { repositories: fields.repositories } : {} }, ready: Promise.resolve(), configured: () => true,
    config: <C>() => config() as unknown as C, receive,
    state: { get: <V>(key: string) => state.get(key) as V | undefined, set: (key, value) => { if (value === undefined) state.delete(key); else state.set(key, value) } },
    threads: { get: key => fields.threads?.[key] ? { meta: fields.threads[key]! } : undefined, describe: vi.fn() },
    tickets: { get: id => fields.tickets?.find(ticket => ticket.id === id), open: () => fields.tickets ?? [] },
    triggers: { get: id => triggers.get(id) },
    report: vi.fn(),
  }
  return { ctx, state, received, receive }
}
const signal = () => new AbortController().signal

describe('token', () => {
  it('asks for an app token with the exact scope string, reuses it, and mints a new one once Linear refuses it', async () => {
    const stub = linear()
    await stub.client.viewer()
    await stub.client.request('query { viewer { id } }', {})
    const tokens = stub.calls.filter(call => call.url.endsWith('/oauth/token'))
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.init.body).toBe('grant_type=client_credentials&scope=read,write,app:assignable,app:mentionable')
    expect(SCOPE).toBe('read,write,app:assignable,app:mentionable')
    expect((tokens[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('client:secret').toString('base64')}`)
    // A token Linear refuses right after it was minted is not replaced at once: Linear evicts an app's oldest tokens past 1,000.
    stub.revoke()
    await expect(stub.client.request('query { viewer { id } }', {})).rejects.toMatchObject({ codes: ['MINT_THROTTLED'] })
    await expect(stub.client.request('query { viewer { id } }', {})).rejects.toMatchObject({ codes: ['MINT_THROTTLED'] })
    expect(stub.calls.filter(call => call.url.endsWith('/oauth/token'))).toHaveLength(1)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + MINT_INTERVAL_MS + 1000)
    await stub.client.request('query { viewer { id } }', {})
    expect(stub.calls.filter(call => call.url.endsWith('/oauth/token'))).toHaveLength(2)
    vi.restoreAllMocks()
  })
  it('holds every request until a rate limit resets', async () => {
    const stub = linear()
    await stub.client.viewer()
    stub.limit(Date.now() + 120_000)
    await expect(stub.client.request('query { viewer { id } }', {})).rejects.toMatchObject({ codes: ['RATELIMITED'] })
    const sent = stub.fetcher.mock.calls.length
    await expect(stub.client.request('query { viewer { id } }', {})).rejects.toMatchObject({ codes: ['RATELIMITED'] })
    expect(stub.fetcher.mock.calls.length).toBe(sent)
  })
})

describe('translation', () => {
  it('turns a person\'s session and prompt into Triggers with stable ids, the Issue as Thread, and the session as Channel', () => {
    const trigger = sessionTrigger(session('s1', '2026-11-12T10:00:00.000Z'), VIEWER)!
    expect(trigger).toMatchObject({ id: 'linear:session:s1', source: 'linear', threads: [{ source: 'linear', id: 'issue:issue-1' }],
      actor: { source: 'linear', id: OWNER }, human: true, addressed: 'direct', text: 'WEB-1: Fix the footer\n\nIt overlaps.',
      channel: { source: 'linear', thread: 'linear:issue:issue-1', address: { session: 's1', issue: 'issue-1', team: TEAM, teamKey: 'WEB', identifier: 'WEB-1' } },
      meta: { team: TEAM, identifier: 'WEB-1', session: 's1', kind: 'session' } })
    expect(sessionTrigger(session('s1', '2026-11-12T10:00:00.000Z', { comment: { id: 'c1', body: '@daedalus please fix' } }), VIEWER)!.text)
      .toBe('@daedalus please fix\n\n(WEB-1: Fix the footer)')
    expect(promptTrigger(prompt('a1', '2026-11-12T10:01:00.000Z'), VIEWER)).toMatchObject({ id: 'linear:prompt:a1', text: 'Also the header',
      threads: [{ id: 'issue:issue-1' }], meta: { session: 's1', activity: 'a1', kind: 'prompt' } })
  })
  it('makes a stop signal explicit, and drops what the app itself wrote', () => {
    expect(promptTrigger(prompt('a2', '2026-11-12T10:02:00.000Z', { signal: 'stop', content: { body: '' } }), VIEWER))
      .toMatchObject({ text: 'Stop requested in Linear.', meta: { signal: 'stop' } })
    expect(sessionTrigger(session('s2', '2026-11-12T10:00:00.000Z', { creator: { id: VIEWER } }), VIEWER)).toBeUndefined()
    expect(promptTrigger(prompt('a3', '2026-11-12T10:00:00.000Z', { user: { id: VIEWER } }), VIEWER)).toBeUndefined()
    expect(sessionTrigger(session('s3', '2026-11-12T10:00:00.000Z', { issue: null }), VIEWER)).toBeUndefined()
  })
  it('listens to the configured teams by key or id, leaves switched-off ones out, and offers a sessions-only admission row per team', () => {
    const kind = linearKind(linear().client)
    expect(kind.scope!({ meta: { team: TEAM, teamKey: 'web' } }, config())).toEqual({ listened: true, observed: false, row: 'WEB' })
    expect(kind.scope!({ meta: { team: 'elsewhere', teamKey: 'ELSE' } }, config())).toEqual({ listened: false, reason: 'team_not_listed' })
    const byId = config({ teams: [{ id: TEAM, key: '', repository: 'acme/widgets', enabled: true }] })
    expect(kind.scope!({ meta: { team: TEAM, teamKey: 'WEB' } }, byId)).toEqual({ listened: true, observed: false, row: TEAM })
    // An entry with an id follows that team only, even when another team now carries its key.
    const pinned = config({ teams: [{ id: TEAM, key: 'WEB', repository: 'acme/widgets', enabled: true }] })
    expect(kind.scope!({ meta: { team: TEAM, teamKey: 'RENAMED' } }, pinned)).toEqual({ listened: true, observed: false, row: 'WEB' })
    expect(kind.scope!({ meta: { team: OTHER_TEAM, teamKey: 'WEB' } }, pinned)).toMatchObject({ listened: false })
    expect(kind.channel!.allowed!({ team: OTHER_TEAM, teamKey: 'WEB' }, pinned)).toBe(false)
    const off = config({ teams: [{ id: '', key: 'WEB', repository: 'acme/widgets', enabled: false }] })
    expect(kind.scope!({ meta: { team: TEAM, teamKey: 'WEB' } }, off)).toMatchObject({ listened: false })
    expect(kind.policy!.rows!(config()).map(row => row.id)).toEqual(['WEB', 'OPS'])
    expect(kind.policy!.rows!(config({ teams: [{ id: '', key: 'WEB', repository: 'acme/widgets', enabled: false },
      { id: '', key: 'OPS', repository: 'acme/widgets', enabled: true }] })).map(row => row.id)).toEqual(['OPS'])
    expect(kind.policy!.rows!(config())[0]).toMatchObject({ cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })
    expect(() => LinearConfigSchema.parse({ teams: [{ repository: 'acme/widgets' }] })).toThrow('A team id or key')
    expect(kind.find!('see WEB-12 and OPS-3')).toEqual({ threads: [], terms: ['WEB-12', 'OPS-3'] })
    expect(kind.accountFields).toEqual(['clientIdFile', 'clientSecretFile'])
    expect(LinearConfigSchema.safeParse({ apiUrl: 'https://evil.example/graphql' }).success).toBe(false)
  })
})

describe('polling', () => {
  const T0 = '2026-11-12T10:00:00.000Z'
  function sources(sessions: Session[], prompts: Prompt[] = []) {
    const activities: Record<string, unknown>[] = []
    const stub = linear({
      agentSessions: () => ({ agentSessions: page(sessions) }),
      agentActivities: () => ({ agentActivities: page(prompts) }),
      agentActivityCreate: variables => { activities.push((variables as { input: Record<string, unknown> }).input); return { agentActivityCreate: { success: true } } },
    })
    return { ...stub, activities }
  }
  it('starts from now, then takes in new sessions and prompts once, answers a new session at once, and leaves a misrouted team out', async () => {
    const stub = sources([session('s1', '2026-11-12T10:01:00.000Z'), session('s2', '2026-11-12T10:02:00.000Z', { issue: issue(OTHER_TEAM, 2) }),
      session('s3', '2026-11-12T10:03:00.000Z', { issue: issue('elsewhere', 3) })], [prompt('a1', '2026-11-12T10:04:00.000Z')])
    const h = context()
    expect(await pollLinear(h.ctx, stub.client, config(), signal())).toMatchObject({ sessions: 0, prompts: 0 })
    expect(h.received).toEqual([])
    h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
    const round = await pollLinear(h.ctx, stub.client, config(), signal())
    // OPS is listed with another repository than the GitHub Source's; an unlisted team goes to receive, whose scope files it as filtered.
    expect(h.received.map(trigger => trigger.id)).toEqual(['linear:session:s1', 'linear:session:s3', 'linear:prompt:a1'])
    expect(round.skipped).toEqual(['OPS'])
    expect(round.misrouted).toEqual(['OPS-2'])
    expect(round.unknown).toEqual([])
    expect(stub.activities).toEqual([{ id: stableUuid('seen:s1'), agentSessionId: 's1', content: { type: 'thought', body: 'Received.' }, ephemeral: true }])
    expect(h.state.get(KEYS.sessions)).toBe('2026-11-12T10:02:55.000Z')
    expect(h.state.get(KEYS.prompts)).toBe('2026-11-12T10:03:55.000Z')
    await pollLinear(h.ctx, stub.client, config(), signal())
    expect(stub.activities).toHaveLength(1)
  })
  it('takes in a team on an additional repository with that repository\'s canonical name, and leaves the primary\'s Triggers unchanged', async () => {
    const stub = sources([session('s1', '2026-11-12T10:01:00.000Z'), session('s2', '2026-11-12T10:02:00.000Z', { issue: issue(OTHER_TEAM, 2) })],
      [prompt('a1', '2026-11-12T10:04:00.000Z', { agentSession: { id: 's2', issue: issue(OTHER_TEAM, 2) } })])
    const teams = [{ id: '', key: 'WEB', repository: 'ACME/Widgets', enabled: true }, { id: '', key: 'OPS', repository: 'acme/other', enabled: true }]
    const h = context({ repositories: ['acme/widgets', 'Acme/Other'] })
    h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
    const round = await pollLinear(h.ctx, stub.client, config({ teams }), signal())
    expect(round).toMatchObject({ sessions: 2, prompts: 1, skipped: [], misrouted: [] })
    expect(h.received.map(trigger => [trigger.id, trigger.meta.repository])).toEqual([['linear:session:s1', undefined],
      ['linear:session:s2', 'Acme/Other'], ['linear:prompt:a1', 'Acme/Other']])
    expect(h.received[0]).toEqual(sessionTrigger(session('s1', '2026-11-12T10:01:00.000Z'), VIEWER))
    expect(stub.activities.map(activity => activity.agentSessionId)).toEqual(['s1', 's2'])
  })
  it('leaves out a team whose repository the deployment does not list, and names it in health', async () => {
    const stub = sources([session('s2', '2026-11-12T10:02:00.000Z', { issue: issue(OTHER_TEAM, 2) })])
    const h = context({ repositories: ['acme/widgets', 'acme/third'] })
    h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
    const round = await pollLinear(h.ctx, stub.client, config(), signal())
    expect(round).toMatchObject({ sessions: 0, skipped: ['OPS'], misrouted: ['OPS-2'] })
    expect(h.received).toEqual([])
  })
  describe('projects', () => {
    const inProject = (n: number, project: { id: string; name?: string } | null, team = TEAM) => ({ ...issue(team, n), project })
    const repositories = ['acme/widgets', 'acme/other']
    async function take(teams: z.input<typeof LinearConfigSchema>['teams'], sessions: Session[], prompts: Prompt[] = []) {
      const stub = sources(sessions, prompts)
      const h = context({ repositories })
      h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
      const round = await pollLinear(h.ctx, stub.client, config({ teams }), signal())
      return { ...h, ...stub, round }
    }

    it('sends two projects of one team to two repositories, by project id, else by name ignoring case for an entry without id', async () => {
      const { received } = await take([{ key: 'WEB', projects: [{ id: 'p-a', repository: 'acme/widgets' }, { name: 'Ops Tools', repository: 'acme/other' },
        { id: 'p-b', name: 'Alpha', repository: 'acme/other' }] }], [
        session('s1', '2026-11-12T10:01:00.000Z', { issue: inProject(1, { id: 'p-a', name: 'Site' }) }),
        session('s2', '2026-11-12T10:02:00.000Z', { issue: inProject(2, { id: 'p-x', name: 'ops tools' }) }),
        session('s3', '2026-11-12T10:03:00.000Z', { issue: inProject(3, { id: 'p-c', name: 'Alpha' }) })])
      expect(received.map(trigger => [trigger.id, trigger.meta.repository, trigger.meta.project])).toEqual([
        ['linear:session:s1', undefined, 'p-a'], ['linear:session:s2', 'acme/other', 'p-x']])
    })

    it('uses the team\'s repository for an Issue without a project or with an unmapped one', async () => {
      const { received, round } = await take([{ key: 'WEB', repository: 'acme/widgets', projects: [{ id: 'p-o', repository: 'acme/other' }] }], [
        session('s1', '2026-11-12T10:01:00.000Z', { issue: inProject(1, null) }),
        session('s2', '2026-11-12T10:02:00.000Z', { issue: inProject(2, { id: 'p-z', name: 'Else' }) }),
        session('s3', '2026-11-12T10:03:00.000Z', { issue: inProject(3, { id: 'p-o', name: 'Ops' }) })])
      expect(received.map(trigger => trigger.meta.repository)).toEqual([undefined, undefined, 'acme/other'])
      expect(round.unmapped).toEqual([])
    })

    it('takes in nothing for an unmapped project of a team without a repository, says why in the session once, and in health', async () => {
      const unmapped = session('s1', '2026-11-12T10:01:00.000Z', { issue: inProject(1, { id: 'p-z', name: 'Else' }) })
      const h = await take([{ key: 'WEB', projects: [{ id: 'p-a', repository: 'acme/widgets' }] }], [unmapped,
        session('s2', '2026-11-12T10:02:00.000Z', { issue: inProject(2, null) })],
        [prompt('a1', '2026-11-12T10:04:00.000Z', { agentSession: { id: 's1', issue: inProject(1, { id: 'p-z', name: 'Else' }) } })])
      expect(h.received).toEqual([])
      expect(h.round).toMatchObject({ sessions: 0, prompts: 0, unmapped: ['WEB-1', 'WEB-2', 'WEB-1'], misrouted: [], skipped: [] })
      expect(h.activities.map(activity => [activity.agentSessionId, activity.content])).toEqual([
        ['s1', { type: 'error', body: 'Not taken in: team WEB names no repository for project Else.' }],
        ['s2', { type: 'error', body: 'Not taken in: team WEB names no repository for Issues without a project.' }]])
      h.state.set(KEYS.sessions, T0)
      await pollLinear(h.ctx, h.client, config({ teams: [{ key: 'WEB', projects: [{ id: 'p-a', repository: 'acme/widgets' }] }] }), signal())
      expect(h.activities).toHaveLength(2)
    })

    it('names a project whose repository is not listed in health, and leaves its Issues out', async () => {
      const { received, round } = await take([{ key: 'WEB', repository: 'acme/widgets', projects: [{ name: 'Lab', repository: 'acme/lab' }] }],
        [session('s1', '2026-11-12T10:01:00.000Z', { issue: inProject(1, { id: 'p-l', name: 'lab' }) })])
      expect(received).toEqual([])
      expect(round).toMatchObject({ skipped: ['WEB/Lab'], misrouted: ['WEB-1'] })
    })

    it('keeps the ticket\'s repository after its Issue moves to a project of another repository', async () => {
      const teams = [{ key: 'WEB', repository: 'acme/widgets', projects: [{ id: 'p-o', repository: 'acme/other' }] }]
      const start = await take(teams, [session('s1', '2026-11-12T10:01:00.000Z', { issue: { ...inProject(1, { id: 'p-o' }), delegate: { id: VIEWER } } })])
      const origin = start.received[0]!
      expect(origin.meta.repository).toBe('acme/other')
      const ticket: Ticket = { id: 't1', origin: { triggerId: origin.id, triggerIds: [origin.id] }, follows: [{ thread: 'github:acme/other#3', own: true }] }
      const updates: { input: { addedExternalUrls: { label: string }[] } }[] = []
      const stub = linear({ agentSessions: () => ({ agentSessions: page([]) }),
        agentActivities: () => ({ agentActivities: page([prompt('a1', '2026-11-12T10:05:00.000Z', { agentSession: { id: 's1', issue: inProject(1, null) } })]) }),
        agentSessionUpdate: variables => { updates.push(variables as never); return { agentSessionUpdate: { success: true } } },
        'issues(': () => ({ issues: { nodes: [{ id: 'issue-1', delegate: null }] } }), history: () => ({ issue: { history: { nodes: [] } } }) })
      const h = context({ tickets: [ticket], triggers: [origin], repositories, threads: { 'github:acme/other#3': { url: 'https://github.com/acme/other/pull/3' } } })
      h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
      await pollLinear(h.ctx, stub.client, config({ teams }), signal())
      expect(h.received.map(trigger => [trigger.meta.kind, trigger.meta.repository])).toEqual([['prompt', undefined], ['undelegated', 'acme/other']])
      expect(updates.map(update => update.input.addedExternalUrls[0]!.label)).toEqual(['Pull request #3'])
    })

    it('needs a repository or projects on a team, and an id or name on a project', () => {
      expect(() => LinearConfigSchema.parse({ teams: [{ key: 'WEB' }] })).toThrow('A repository or projects')
      expect(() => LinearConfigSchema.parse({ teams: [{ key: 'WEB', projects: [{ repository: 'acme/widgets' }] }] })).toThrow('A project id or name')
      expect(LinearConfigSchema.parse({ teams: [{ key: 'WEB', repository: 'acme/widgets' }] }).teams[0]).toMatchObject({ projects: [] })
    })
  })

  it('keeps its cursors where they are after a round with nothing new', async () => {
    const stub = sources([])
    const h = context()
    h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
    for (let i = 0; i < 3; i++) await pollLinear(h.ctx, stub.client, config(), signal())
    expect([h.state.get(KEYS.sessions), h.state.get(KEYS.prompts)]).toEqual([T0, T0])
  })
  it('finds every session after the cursor whichever way Linear orders the pages', async () => {
    const old = (n: number) => session(`old-${n}`, `2026-11-12T09:5${n}:00.000Z`)
    const fresh = (n: number) => session(`new-${n}`, `2026-11-12T10:0${n}:00.000Z`)
    for (const pages of [[[fresh(2), fresh(1)], [old(2), old(1)]], [[old(1), old(2)], [fresh(1), fresh(2)]]]) {
      let at = 0
      const stub = linear({ agentSessions: () => ({ agentSessions: { nodes: pages[at]!, pageInfo: { hasNextPage: at++ < pages.length - 1, endCursor: `c${at}` } } }),
        agentActivities: () => ({ agentActivities: page([]) }), agentActivityCreate: () => ({ agentActivityCreate: { success: true } }) })
      const h = context()
      h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
      await pollLinear(h.ctx, stub.client, config(), signal())
      expect(h.received.map(trigger => trigger.id)).toEqual(['linear:session:new-1', 'linear:session:new-2'])
    }
  })
  it('keeps the cursor when a session was not taken in, and reads it again next round', async () => {
    const stub = sources([session('s1', '2026-11-12T10:01:00.000Z'), session('s2', '2026-11-12T10:02:00.000Z')])
    const h = context()
    h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
    h.receive.mockImplementationOnce(async () => { throw new Error('store busy') })
    await expect(pollLinear(h.ctx, stub.client, config(), signal())).rejects.toThrow('not taken in')
    expect(h.state.get(KEYS.sessions)).toBe(T0)
    await pollLinear(h.ctx, stub.client, config(), signal())
    expect(h.received.map(trigger => trigger.id)).toEqual(['linear:session:s2', 'linear:session:s1', 'linear:session:s2'])
    expect(h.state.get(KEYS.sessions)).toBe('2026-11-12T10:01:55.000Z')
  })
  it('stops between items when its signal aborts', async () => {
    const stub = sources([session('s1', '2026-11-12T10:01:00.000Z')])
    const h = context()
    h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
    const controller = new AbortController()
    h.receive.mockImplementationOnce(async () => { controller.abort(); throw new Error('aborted') })
    await expect(pollLinear(h.ctx, stub.client, config(), controller.signal)).rejects.toThrow()
    expect(h.state.get(KEYS.sessions)).toBe(T0)
  })
  it('links the ticket\'s pull request into the session once, and completes the Issue once that pull request merged', async () => {
    const updates: unknown[] = [], states: unknown[] = []
    const stub = linear({
      agentSessions: () => ({ agentSessions: page([]) }), agentActivities: () => ({ agentActivities: page([]) }),
      agentSessionUpdate: variables => { updates.push(variables); return { agentSessionUpdate: { success: true } } },
      'issue(id': () => ({ issue: { state: { type: 'started' }, team: { states: { nodes: [{ id: 'done-2', type: 'completed', position: 5 }, { id: 'done-1', type: 'completed', position: 2 }] } } } }),
      issueUpdate: variables => { states.push(variables); return { issueUpdate: { success: true } } },
    })
    const origin = sessionTrigger(session('s1', T0), VIEWER)!
    const ticket: Ticket = { id: 't1', origin: { triggerId: origin.id, triggerIds: [origin.id] }, follows: [{ thread: 'github:54', own: true }] }
    const h = context({ tickets: [ticket], triggers: [origin], threads: { 'github:54': { url: 'https://github.com/acme/widgets/pull/54' } } })
    h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
    await pollLinear(h.ctx, stub.client, config(), signal())
    await pollLinear(h.ctx, stub.client, config(), signal())
    expect(updates).toEqual([{ id: 's1', input: { addedExternalUrls: [{ label: 'Pull request #54', url: 'https://github.com/acme/widgets/pull/54' }] } }])
    expect(states).toEqual([])
    ticket.follows = [{ thread: 'github:54', own: true, closed: { at: T0, outcome: 'merged' } }]
    await pollLinear(h.ctx, stub.client, config(), signal())
    await pollLinear(h.ctx, stub.client, config(), signal())
    expect(states).toEqual([{ id: 'issue-1', state: 'done-1' }])
  })
  it('completes nothing for another ticket\'s merged pull request or with completeOnMerge off, and forgets ended tickets', async () => {
    const states: unknown[] = []
    const stub = linear({
      agentSessions: () => ({ agentSessions: page([]) }), agentActivities: () => ({ agentActivities: page([]) }),
      agentSessionUpdate: () => ({ agentSessionUpdate: { success: true } }),
      'issue(id': () => ({ issue: { state: { type: 'started' }, team: { states: { nodes: [{ id: 'done', type: 'completed', position: 1 }] } } } }),
      issueUpdate: variables => { states.push(variables); return { issueUpdate: { success: true } } },
    })
    const origin = sessionTrigger(session('s1', T0), VIEWER)!
    const merged = { at: T0, outcome: 'merged' as const }
    const followed: Ticket = { id: 't1', origin: { triggerId: origin.id, triggerIds: [origin.id] }, follows: [{ thread: 'github:7', own: false, closed: merged }] }
    const own: Ticket = { id: 't2', origin: { triggerId: origin.id, triggerIds: [origin.id] }, follows: [{ thread: 'github:8', own: true, closed: merged }] }
    const tickets = [followed, own]
    const h = context({ tickets, triggers: [origin] })
    h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
    await pollLinear(h.ctx, stub.client, config({ completeOnMerge: false }), signal())
    expect(states).toEqual([])
    expect(h.state.get(KEYS.followed)).toEqual(['t1', 't2'])
    // Both tickets end: one last look, then neither is followed any longer.
    const open = vi.spyOn(h.ctx.tickets, 'open').mockReturnValue([])
    await pollLinear(h.ctx, stub.client, config(), signal())
    expect(states).toEqual([{ id: 'issue-1', state: 'done' }])
    expect(h.state.get(KEYS.followed)).toEqual([])
    open.mockRestore()
  })
  it('labels a linked pull request by the ticket\'s repository, naming any other repository in full', async () => {
    const updates: { input: { addedExternalUrls: { label: string }[] } }[] = []
    const stub = linear({ agentSessions: () => ({ agentSessions: page([]) }), agentActivities: () => ({ agentActivities: page([]) }),
      agentSessionUpdate: variables => { updates.push(variables as never); return { agentSessionUpdate: { success: true } } } })
    const found = sessionTrigger(session('s1', T0, { issue: issue(OTHER_TEAM, 2) }), VIEWER)!
    const origin: Trigger = { ...found, meta: { ...found.meta, repository: 'Acme/Other' } }
    const ticket: Ticket = { id: 't1', origin: { triggerId: origin.id, triggerIds: [origin.id] }, execution: { repository: 'Acme/Other' },
      follows: [{ thread: 'github:Acme/Other#7', own: true }, { thread: 'github:9', own: false }, { thread: 'github:ci:main', own: false }] }
    const h = context({ tickets: [ticket], triggers: [origin],
      repositories: ['acme/widgets', 'Acme/Other'], threads: { 'github:Acme/Other#7': { url: 'https://github.com/Acme/Other/pull/7' },
        'github:9': { url: 'https://github.com/acme/widgets/pull/9' }, 'github:ci:main': { url: 'https://github.com/acme/widgets/actions' } } })
    h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
    await pollLinear(h.ctx, stub.client, config(), signal())
    expect(updates.map(update => update.input.addedExternalUrls[0]!.label)).toEqual(['Pull request #7', 'Pull request acme/widgets#9'])
    expect(pullOf('github:12', 'acme/widgets')).toEqual({ repository: 'acme/widgets', number: '12' })
    expect(pullOf('github:ci:main', 'acme/widgets')).toBeUndefined()
  })
  it('puts the ticket\'s repository on an undelegation stop, and none for the primary', () => {
    const origin = sessionTrigger(session('s1', T0), VIEWER)!
    expect(undelegationTrigger(origin, 't1', undefined, T0, 'Acme/Other').meta.repository).toBe('Acme/Other')
    expect(undelegationTrigger(origin, 't1', undefined, T0).meta).not.toHaveProperty('repository')
  })
  describe('delegation', () => {
    function delegation(delegate: () => string | null, history: unknown[] = []) {
      const reads: unknown[] = []
      const stub = linear({
        agentSessions: () => ({ agentSessions: page([]) }), agentActivities: () => ({ agentActivities: page([]) }),
        'issues(': variables => { reads.push(variables); return { issues: { nodes: [{ id: 'issue-1', delegate: delegate() === null ? null : { id: delegate() } }] } } },
        history: () => ({ issue: { history: { nodes: history } } }),
      })
      return { ...stub, reads }
    }
    const delegated = session('s1', T0, { issue: { ...issue(), delegate: { id: VIEWER } } })
    const removal = { id: 'h2', createdAt: '2026-11-12T10:05:00.000Z', actor: { id: OWNER, name: 'Owner' }, fromDelegate: { id: VIEWER }, toDelegate: null }
    const round = async (h: ReturnType<typeof context>, stub: { client: LinearClient }) => {
      h.state.set(KEYS.delegationChecked, undefined)
      await pollLinear(h.ctx, stub.client, config(), signal())
    }
    function running(origin: Trigger) {
      const ticket: Ticket = { id: 't1', origin: { triggerId: origin.id, triggerIds: [origin.id] } }
      const h = context({ tickets: [ticket], triggers: [origin] })
      h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
      return h
    }

    it('stops a running ticket once its Issue is no longer delegated to the app, attributed to the change, and only once', async () => {
      let current: string | null = VIEWER
      const stub = delegation(() => current, [
        { id: 'h1', createdAt: '2026-11-12T09:59:00.000Z', actor: { id: OWNER }, fromDelegate: null, toDelegate: { id: VIEWER } }, removal])
      const h = running(sessionTrigger(delegated, VIEWER)!)
      await round(h, stub)
      expect(h.received).toEqual([])
      current = null
      await round(h, stub)
      await round(h, stub)
      expect(h.received).toHaveLength(1)
      expect(h.received[0]).toMatchObject({ id: 'linear:undelegated:h2', actor: { source: 'linear', id: OWNER }, human: true, at: removal.createdAt,
        text: 'Stop requested in Linear.\n\nOwner removed the app as the delegate of WEB-1.', threads: [{ source: 'linear', id: 'issue:issue-1' }],
        channel: { address: { session: 's1', issue: 'issue-1' } }, meta: { issue: 'issue-1', session: 's1', kind: 'undelegated', signal: 'stop' } })
      expect(stub.reads).toEqual([{ ids: ['issue-1'] }, { ids: ['issue-1'] }, { ids: ['issue-1'] }])
    })

    it('stops when the delegation is gone by the first check, and also when it went to another agent', async () => {
      const stub = delegation(() => 'other-agent', [{ ...removal, toDelegate: { id: 'other-agent' } }])
      const h = running(sessionTrigger(delegated, VIEWER)!)
      await round(h, stub)
      expect(h.received.map(trigger => trigger.id)).toEqual(['linear:undelegated:h2'])
    })

    it('puts the ticket\'s repository on the stop', async () => {
      const stub = delegation(() => null, [removal])
      const origin = sessionTrigger(delegated, VIEWER)!
      const ticket: Ticket = { id: 't1', origin: { triggerId: origin.id, triggerIds: [origin.id] }, execution: { repository: 'Acme/Other' } }
      const h = context({ tickets: [ticket], triggers: [origin], repositories: ['acme/widgets', 'Acme/Other'] })
      h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
      await round(h, stub)
      expect(h.received.map(trigger => trigger.meta.repository)).toEqual(['Acme/Other'])
    })

    it('still stops, unattributed, when the history does not show the change, only shows one before the ticket started, or cannot be read', async () => {
      const histories: (() => unknown)[] = [() => ({ issue: { history: { nodes: [] } } }),
        () => ({ issue: { history: { nodes: [{ ...removal, createdAt: '2026-11-12T09:58:00.000Z' }] } } }),
        () => { throw new Error('history unavailable') }]
      for (const history of histories) {
        const stub = linear({ agentSessions: () => ({ agentSessions: page([]) }), agentActivities: () => ({ agentActivities: page([]) }),
          'issues(': () => ({ issues: { nodes: [{ id: 'issue-1', delegate: null }] } }), history })
        const h = running(sessionTrigger(delegated, VIEWER)!)
        await round(h, stub)
        expect(h.received).toHaveLength(1)
        expect(h.received[0]!.id).toMatch(/^linear:undelegated:t1:\d{4}-\d\d-\d\dT/)
        expect(h.received[0]).toMatchObject({ human: false, actor: { id: '' }, at: h.received[0]!.id.slice('linear:undelegated:t1:'.length),
          text: 'Stop requested in Linear.\n\nSomeone removed the app as the delegate of WEB-1.', meta: { kind: 'undelegated', signal: 'stop' } })
        expect(h.received[0]!.meta.history).toBeUndefined()
      }
    })

    it('keeps an unattributed stop\'s id across a retry, and gives a later removal a new one', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(new Date('2026-11-12T11:00:00.000Z'))
        let current: string | null = null
        const stub = delegation(() => current, [])
        const h = running(sessionTrigger(delegated, VIEWER)!)
        h.receive.mockRejectedValueOnce(new Error('busy'))
        await round(h, stub)
        vi.setSystemTime(new Date('2026-11-12T11:01:00.000Z'))
        await round(h, stub)
        current = VIEWER
        await round(h, stub)
        current = null
        vi.setSystemTime(new Date('2026-11-12T11:02:00.000Z'))
        await round(h, stub)
        expect(h.receive.mock.calls.map(([trigger]) => trigger.id)).toEqual(['linear:undelegated:t1:2026-11-12T11:00:00.000Z',
          'linear:undelegated:t1:2026-11-12T11:00:00.000Z', 'linear:undelegated:t1:2026-11-12T11:02:00.000Z'])
      } finally { vi.useRealTimers() }
    })

    it('reads the delegates 50 Issues at a time, and still checks the others when one chunk fails', async () => {
      const reads: string[][] = []
      const stub = linear({ agentSessions: () => ({ agentSessions: page([]) }), agentActivities: () => ({ agentActivities: page([]) }),
        'issues(': variables => {
          const ids = variables.ids as string[]
          reads.push(ids)
          if (ids.includes('issue-1')) throw new Error('Internal error')
          return { issues: { nodes: ids.map(id => ({ id, delegate: null })) } }
        },
        history: () => ({ issue: { history: { nodes: [] } } }) })
      const origins = Array.from({ length: 60 }, (_, n) => sessionTrigger(session(`s${n + 1}`, T0, { issue: { ...issue(TEAM, n + 1), delegate: { id: VIEWER } } }), VIEWER)!)
      const tickets: Ticket[] = origins.map((origin, n) => ({ id: `t${n + 1}`, origin: { triggerId: origin.id, triggerIds: [origin.id] } }))
      const h = context({ tickets, triggers: origins })
      h.state.set(KEYS.sessions, T0); h.state.set(KEYS.prompts, T0)
      await round(h, stub)
      expect(reads.map(ids => ids.length)).toEqual([50, 10])
      expect(h.received.map(trigger => trigger.meta.issue)).toEqual(Array.from({ length: 10 }, (_, n) => `issue-${n + 51}`))
    })

    it('skips an Issue Linear no longer returns, and stops its ticket once it is back without the delegation', async () => {
      let nodes: unknown[] = []
      const stub = linear({ agentSessions: () => ({ agentSessions: page([]) }), agentActivities: () => ({ agentActivities: page([]) }),
        'issues(': () => ({ issues: { nodes } }), history: () => ({ issue: { history: { nodes: [removal] } } }) })
      const h = running(sessionTrigger(delegated, VIEWER)!)
      await round(h, stub)
      expect(h.received).toEqual([])
      nodes = [{ id: 'issue-1', delegate: null }]
      await round(h, stub)
      expect(h.received.map(trigger => trigger.id)).toEqual(['linear:undelegated:h2'])
    })

    it('leaves a ticket the app was only mentioned on running, and stops it after a later delegation is removed', async () => {
      let current: string | null = null
      const stub = delegation(() => current, [removal])
      const h = running(sessionTrigger(session('s1', T0), VIEWER)!)
      await round(h, stub)
      expect(h.received).toEqual([])
      current = VIEWER
      await round(h, stub)
      current = null
      await round(h, stub)
      expect(h.received.map(trigger => trigger.id)).toEqual(['linear:undelegated:h2'])
    })

    it('reads the delegates at most every 30 seconds, and not at all without a running Linear ticket', async () => {
      const stub = delegation(() => VIEWER)
      const h = running(sessionTrigger(delegated, VIEWER)!)
      await pollLinear(h.ctx, stub.client, config(), signal())
      await pollLinear(h.ctx, stub.client, config(), signal())
      expect(stub.reads).toHaveLength(1)
      h.state.set(KEYS.delegationChecked, new Date(Date.now() - DELEGATION_INTERVAL_MS).toISOString())
      await pollLinear(h.ctx, stub.client, config(), signal())
      expect(stub.reads).toHaveLength(2)
      const idle = context()
      idle.state.set(KEYS.sessions, T0); idle.state.set(KEYS.prompts, T0)
      await pollLinear(idle.ctx, stub.client, config(), signal())
      expect(stub.reads).toHaveLength(2)
    })

    it('keeps the round going when the delegates cannot be read, and tries the stop again when it was not taken in', async () => {
      const failing = linear({ agentSessions: () => ({ agentSessions: page([]) }), agentActivities: () => ({ agentActivities: page([]) }) })
      const h = running(sessionTrigger(delegated, VIEWER)!)
      await expect(round(h, failing)).resolves.toBeUndefined()
      const stub = delegation(() => null, [removal])
      h.receive.mockRejectedValueOnce(new Error('busy'))
      await round(h, stub)
      expect(h.received).toEqual([])
      await round(h, stub)
      expect(h.received.map(trigger => trigger.id)).toEqual(['linear:undelegated:h2'])
    })
  })
})

it('reports configured teams Linear does not know', async () => {
  const stub = linear({ agentSessions: () => ({ agentSessions: page([]) }), agentActivities: () => ({ agentActivities: page([]) }) })
  const h = context()
  h.state.set(KEYS.sessions, '2026-11-12T10:00:00.000Z'); h.state.set(KEYS.prompts, '2026-11-12T10:00:00.000Z')
  const round = await pollLinear(h.ctx, stub.client, config({ teams: [{ id: '', key: 'WEB', repository: 'acme/widgets', enabled: true },
    { id: '', key: 'NOPE', repository: 'acme/widgets', enabled: true }, { id: 'missing-id', key: '', repository: 'acme/widgets', enabled: true },
    { id: 'gone-id', key: 'WEB', repository: 'acme/widgets', enabled: true }] }), signal())
  // An entry with an id is checked by its id, whatever team holds its key now.
  expect(round.unknown).toEqual(['NOPE', 'missing-id', 'WEB'])
})

/** The health one `watchLinear` round reports, with `config` as the Source's configuration. */
async function healthOf(stub: ReturnType<typeof linear>, value: LinearConfig) {
  const h = context()
  h.ctx.config = <C>() => value as unknown as C
  h.state.set(KEYS.sessions, '2026-11-12T10:00:00.000Z'); h.state.set(KEYS.prompts, '2026-11-12T10:00:00.000Z')
  const controller = new AbortController()
  vi.mocked(h.ctx.report).mockImplementation(() => { controller.abort() })
  await watchLinear(h.ctx, stub.client, controller.signal)
  return { health: vi.mocked(h.ctx.report).mock.calls.at(-1)![1], received: h.received }
}
it('makes a configured team Linear does not know a health error', async () => {
  const stub = linear({ agentSessions: () => ({ agentSessions: page([]) }), agentActivities: () => ({ agentActivities: page([]) }) })
  const { health } = await healthOf(stub, config({ teams: [{ id: '', key: 'WEB', repository: 'acme/widgets', enabled: true },
    { id: '', key: 'NOPE', repository: 'acme/widgets', enabled: true }] }))
  expect(health).toMatchObject({ state: 'error', detail: expect.stringContaining('teams NOPE not found in Linear') })
})
it('keeps taking sessions in when the team list cannot be read, and says the teams are unverified', async () => {
  const stub = linear({ 'teams(': () => ({}), agentSessions: () => ({ agentSessions: page([session('s1', '2026-11-12T10:01:00.000Z')]) }),
    agentActivities: () => ({ agentActivities: page([]) }), agentActivityCreate: () => ({ agentActivityCreate: { success: true } }) })
  const { health, received } = await healthOf(stub, config({ teams: [{ id: '', key: 'WEB', repository: 'acme/widgets', enabled: true }] }))
  expect(received.map(trigger => trigger.id)).toEqual(['linear:session:s1'])
  expect(health).toMatchObject({ state: 'ready', detail: expect.stringContaining('teams unverified') })
})

describe('replies', () => {
  const message = (kind: OutboundMessage['kind']): OutboundMessage => ({ id: 'reply-1', kind, text: 'Done: see the PR',
    channel: { source: 'linear', thread: 'linear:issue:issue-1', address: { session: 's1', issue: 'issue-1', team: TEAM } } })
  it('sends an acknowledgement as a thought and a reply as a response, with an id fixed by the message', async () => {
    const inputs: Record<string, unknown>[] = []
    const stub = linear({ agentActivityCreate: variables => { inputs.push((variables as { input: Record<string, unknown> }).input); return { agentActivityCreate: { success: true } } } })
    expect(await sendLinear(stub.client, message('acknowledgement'))).toBe('sent')
    expect(await sendLinear(stub.client, message('reply'))).toBe('sent')
    expect(inputs.map(input => (input.content as { type: string }).type)).toEqual(['thought', 'response'])
    expect(inputs[0]!.id).toBe(stableUuid('message:reply-1'))
    expect(inputs[0]!.id).toBe(inputs[1]!.id)
    expect(String(inputs[0]!.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('counts a create Linear stored before failing as sent, retries any other failure, and drops a deleted session', async () => {
    let stored = false
    const stub = linear({
      agentActivityCreate: () => { stored = true; throw new Error('Conflict: id already in use') },
      'agentActivity(id': () => ({ agentActivity: stored ? { id: 'x' } : null }),
    })
    expect(await sendLinear(stub.client, message('reply'))).toBe('sent')
    const lost = linear({ agentActivityCreate: () => { throw new Error('Internal error') }, 'agentActivity(id': () => ({ agentActivity: null }) })
    await expect(sendLinear(lost.client, message('reply'))).rejects.toThrow('Internal error')
    const gone = linear({ agentActivityCreate: () => { throw Object.assign(new Error('Entity not found: AgentSession'), { code: 'INVALID_INPUT' }) } })
    expect(await sendLinear(gone.client, message('reply'))).toBe('gone')
  })
})

describe('plugin', () => {
  it('registers the kind with the orchestrator, and its disposer unregisters it and stops the loop', async () => {
    const effects: (() => unknown)[] = []
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    const h = context()
    const ctx = { orchestrator: { sources: { register }, context: () => ({ ...h.ctx, configured: () => false }) },
      effect: (execute: () => (() => unknown) | void) => { const dispose = execute(); if (dispose) effects.push(dispose) } }
    apply(ctx)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'linear', health: ['linear'] }))
    for (const dispose of effects) await dispose()
    expect(unregister).toHaveBeenCalled()
    expect(h.ctx.report).toHaveBeenCalledWith('linear', { state: 'paused', detail: 'Waiting for the deployment check' })
  })
})
