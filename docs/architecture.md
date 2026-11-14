# Architecture

dsh-superagent-linear is a cordis plugin for DSH. It registers one Source kind, `linear`, with dsh-superagent and runs a polling loop against Linear's GraphQL API. It holds no database of its own: all state goes through the Source context dsh-superagent provides.

## Context

```mermaid
flowchart LR
  person([Person in Linear])
  linear[Linear API<br/>api.linear.app]
  subgraph dsh[DSH process]
    web[DSH web server]
    plugin[dsh-superagent-linear]
    superagent[dsh-superagent<br/>orchestrator]
    github[GitHub Source]
  end
  worker[Worker Session]

  person -- delegates, mentions, prompts --> linear
  linear -- webhook delivery --> web
  web -- /hooks/linear --> plugin
  plugin -- GraphQL queries, mutations --> linear
  plugin -- Triggers, issue closes --> superagent
  superagent -- replies --> plugin
  superagent -- tickets --> worker
  github -- pull request Threads --> superagent
```

The plugin depends on the GitHub Source in two ways. It routes an Issue only to a repository the GitHub Source serves. It learns about pull requests and merges from the GitHub Threads a ticket follows.

## Components

| File | Role |
| --- | --- |
| `src/index.ts` | Plugin entry. Registers the Source kind, starts the polling loop, and registers the webhook route when DSH offers the optional `webServer` service. |
| `src/linear.ts` | The Source kind: config schema, panel fields, Policy, admission rows, Channel, execution environment. Also the polling round (`pollLinear`), Trigger builders, routing, pull request links and issue-close checks, and the loop (`watchLinear`). |
| `src/linear-chain.ts` | Chain mode: starting runs, advancing chains, stopping them, answering prompts and mentions on epics, and detecting re-delegation. |
| `src/linear-api.ts` | `LinearClient`: token handling, rate-limit hold, GraphQL operations, idempotent activity creation. |
| `src/webhook.ts` | `handleWebhook` checks a delivery. `Waker` ends the loop's wait early. |
| `src/types.ts` | The parts of dsh-superagent's Source interface the plugin uses, written out structurally. |

```mermaid
flowchart TB
  index[index.ts<br/>apply]
  kind[linear.ts<br/>linearKind]
  loop[linear.ts<br/>watchLinear / pollLinear]
  chain[linear-chain.ts]
  client[linear-api.ts<br/>LinearClient]
  hook[webhook.ts<br/>handleWebhook, Waker]

  index --> kind
  index --> loop
  index --> hook
  hook -- wake --> loop
  loop --> chain
  loop --> client
  chain --> client
  kind -- channel.send --> client
```

`index.ts` runs the loop inside a cordis effect. Disposing the plugin aborts the loop and unregisters the kind. DSH ends its process on an unhandled rejection, so an error that escapes the loop becomes the Source's health instead.

## The loop

`watchLinear` waits for dsh-superagent to be ready. When the deployment is not configured, it reports `paused` and exits. Otherwise it repeats:

1. Read the current config. Report `paused` when the Source is off, a credential file is unset, or no team is enabled.
2. Run one round with `pollLinear`.
3. Report health: `ready`, or `error` when teams are skipped or unknown.
4. Wait `pollSeconds`, or less when the webhook woke it.

A failed round counts as a failure. Three in a row make health `error`. A refused token or a rate limit makes it `error` at once, as no request can succeed until it passes.

## A round

```mermaid
sequenceDiagram
  participant L as Linear
  participant P as pollLinear
  participant H as dsh-superagent

  P->>L: teams (cached 10 min), viewer (cached)
  P->>L: AgentSessions since session cursor
  loop each new session
    P->>L: agentActivityCreate "Received." (ephemeral)
    P->>L: IssueContext (parent, sub-issues)
    alt Issue has sub-issues
      P->>L: start chain or answer with status
    else
      P->>H: receive(session Trigger)
    end
  end
  P->>L: AgentActivities (prompts) since prompt cursor
  loop each new prompt
    P->>H: receive(prompt Trigger), unless an epic answers it
  end
  P->>L: agentSessionUpdate (pull request links), issueUpdate (complete)
  P->>L: DelegatedIssues, issues (delegate, state), every 30 s
  P->>H: receive(undelegation stop), issueClosed
  P->>L: ChainRead per active epic, every 30 s
  P->>H: receive(chain Triggers)
```

### Sessions

For each session after the cursor, the round:

1. Skips sessions the chain opened itself, and sessions the app created.
2. Routes the Issue to a repository (see [Routing](#routing)). A misrouted Issue is left out. An unmapped one gets one `error` activity.
3. Posts the ephemeral "Received." thought once per session.
4. Reads the Issue context (parent and up to 30 sub-issues) once per new Trigger.
5. For an Issue with sub-issues: a person's delegation, without a comment, starts a chain. A person's mention gets the chain status. Nothing else follows.
6. For a delegated Issue whose context could not be read: holds the session for up to 10 minutes by failing the round, then posts an error.
7. Otherwise adds the context header, applies split mode, and calls `receive`.

### Prompts

For each prompt after the cursor, the round finds an open ticket on the same Issue. With one, the prompt follows that ticket's team and repository. Without one, it is routed like a session. A routed prompt on an epic goes to the chain logic first, which may start a run, stop one, or answer with the status instead of a Trigger.

### Cursors

A cursor moves only when every item it passes was taken in. The next cursor is five seconds before the newest item read, to catch writes Linear records late, and never moves back. Fixed Trigger ids make the overlap harmless. A round in which an item was not taken in throws after finishing the other steps, so the next round reads it again.

### Routing

`routeOf` gives one of four results for a Trigger:

| Result | When | Effect |
| --- | --- | --- |
| `unlisted` | No enabled team matches. | Passed to `receive`. The scope filter in dsh-superagent drops it. |
| `unmapped` | The team matches, but neither the project entry nor the team names a repository. | Not taken in. One `error` activity on a new session. |
| `misrouted` | The named repository is not one the GitHub Source serves. | Not taken in. Listed in health as "left out". |
| `served` | The repository is served. | Taken in. A non-primary repository goes into `meta.repository`. |

## Chains

A chain record per epic is stored under `linear-chain:<epic id>`:

| Field | Meaning |
| --- | --- |
| `run` | Id of what started the run: the session, the prompt, or the history entry of a re-delegation. Starting the same run twice is a no-op. |
| `session` | The epic's session, where plans, status and results go. Empty when a re-delegation found none. |
| `delegator` | The person whose Triggers the sub-issues carry. |
| `status` | `running`, `stopped` or `done`. |
| `started` | Per sub-issue: its session, Trigger and ticket. |
| `checked` | When the epic was last read. |

```mermaid
stateDiagram-v2
  [*] --> running: delegation, start prompt, re-delegation
  running --> running: start ready sub-issues
  running --> done: all sub-issues closed
  running --> stopped: stop condition
  done --> [*]: epic completed, summary posted
  stopped --> running: new run
```

`advanceChains` reads each running epic at most every 30 seconds, or at once when a sub-issue's ticket ended. `chainParallel` caps started sub-issues across all chains. A started sub-issue counts while it has an open ticket, a Trigger without a ticket yet, or an ended ticket whose Issue is still being completed.

A chain record is written as `done` before the epic is completed. A crash in between completes it on the next round.

## Stored state

All keys live in the Source context's state store.

| Key | Holds |
| --- | --- |
| `linear-sessions-cursor`, `linear-prompts-cursor` | Intake cursors. |
| `linear-seen:<session>` | The session was answered. |
| `linear-linked:<session>:<url>` | The pull request link was added. |
| `linear-completed:<ticket>` | The Issue was completed after a merge. |
| `linear-followed-tickets` | Tickets whose pull requests are followed. |
| `linear-delegation`, `linear-delegation-checked` | Delegate state per ticket and the last check time. |
| `linear-closing-tickets` | Tickets whose Issue is watched for a close. |
| `linear-chain:<epic>`, `linear-chains` | Chain records and the active list. |
| `linear-chain-sessions` | Sessions the chain opened, kept 14 days. |
| `linear-chain-run:<id>` | A session, prompt or history entry was handled by the chain logic. |
| `linear-chain-held:<id>` | When an unreadable delegated session or prompt was first held. |
| `linear-watched` | Issues the Source saw a session or ticket on, kept 14 days. |
| `linear-delegated-checked` | The last re-delegation check. |

## Integration with dsh-superagent

The kind uses these parts of dsh-superagent's Source interface:

- `scope`: a Trigger is listened to when an enabled team matches. The admission row is the team's name.
- `channel.allowed`, `channel.send`, `channel.link`: replies go to the session; links point at the Issue.
- `find`: Issue identifiers such as `ENG-12` in a search query become search terms.
- `policy`: the allowed list of Linear user ids, and one admission row per enabled team, marked "Sessions only".
- `environment`: the variables listed in [Configuration](configuration.md#execution-environment).
- `accountFields`: the three file paths. Only the panel and the plugin configuration may change them.
- `tickets.issueClosed`: optional. On a host without it, the Source does not watch Issues for closes.
