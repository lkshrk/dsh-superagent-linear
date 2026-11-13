/** The parts of dsh-superagent's Source interface (src/sources/kind.ts, host.ts) this package uses, written out structurally. */
import type { z } from 'zod'

export type Localized = { zh: string; en: string }
export interface ThreadRef { source: string; id: string }
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }
export interface Trigger {
  id: string
  source: string
  threads: ThreadRef[]
  actor: { source: string; id: string }
  human: boolean
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  meta: Record<string, unknown>
}
export interface OutboundMessage { id: string; channel: ChannelRef; text: string; kind: 'acknowledgement' | 'reply' | 'notice'; ticketId?: string }
export type ReceiveResult = string
export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string }
export interface Follow { thread: string; own: boolean; closed?: { at: string; outcome: 'merged' | 'closed' } }
export interface Ticket { id: string; follows?: Follow[]; origin: { triggerId: string; triggerIds: string[] }; execution?: { repository?: string } }
export interface Thread { meta: Record<string, unknown> }

type FieldBase = { key: string; label: Localized; hint?: Localized; advanced?: boolean; optional?: boolean }
export type FieldSpec =
  | FieldBase & { type: 'switch' }
  | FieldBase & { type: 'number'; min: number; max: number }
  | FieldBase & { type: 'text'; pattern?: string; readonly?: boolean }
  | FieldBase & { type: 'rows'; columns: { key: string; label: Localized; type: 'text'; pattern?: string; optional?: boolean }[] }
export interface AdmissionRowView { id: string; label: Localized | string; note: Localized; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }

export interface SourceContext {
  readonly deployment: { repository: string; repositories?: string[] }
  readonly ready: Promise<void>
  configured(): boolean
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  state: { get<V>(key: string): V | undefined; set<V>(key: string, value: V | undefined): void }
  threads: { get(key: string): Thread | undefined; describe(key: string, description: { label?: string; url?: string }): void }
  tickets: { get(id: string): Ticket | undefined; open(): Ticket[] }
  triggers: { get(id: string): Trigger | undefined }
  report(entry: string, health: Health): void
}
export interface SourceKind<C extends Record<string, unknown>> {
  kind: string
  title: Localized
  description: Localized
  schema: z.ZodType<C>
  accountFields?: readonly string[]
  fields: FieldSpec[]
  health: string[]
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  channel?: {
    allowed?(address: Record<string, string>, config: C): boolean
    send(host: unknown, message: OutboundMessage): Promise<'sent' | 'gone'>
    link(address: Record<string, string>): { url: string; label: Localized }
  }
  find?(query: string): { threads: string[]; terms: string[] }
  policy?: {
    schema: z.ZodType<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>
    fields: FieldSpec[]
    explicit: Localized
    unnamed?: { person: Localized; bot: Localized }
    rows?(config: Record<string, unknown>): AdmissionRowView[]
  }
  environment?: { variables: readonly { key: string; description: Localized }[]; values(input: { config: C; trigger?: Trigger }): Record<string, string> }
}
/** dsh-superagent's `orchestrator` service, as a Source plugin uses it. */
export interface SourceHost {
  sources: { register(kind: object): () => void }
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}
