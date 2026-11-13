# dsh-superagent-linear

A Linear Source for [dsh-superagent](https://github.com/lkshrk/dsh-superagent). A Linear agent app's sessions on the listed teams become Triggers: a person delegates an Issue to the app, or mentions it in a comment, and later prompts in the session follow. dsh-superagent's replies go back into the session as agent activities.

It is a separate package that registers its Source kind through dsh-superagent's `orchestrator` service, as other community Sources do. A Source kind is a single registration per dsh-superagent; install it once.

## Install

```sh
dsh plugin --profile <profile> add "github:lkshrk/dsh-superagent-linear#<commit>"
```

pnpm builds a Git install through the `prepare` script and blocks it until allowed: add the key pnpm prints, `dsh-superagent-linear@https://codeload.github.com/lkshrk/dsh-superagent-linear/tar.gz/<commit>: true`, under `allowBuilds` in the profile's `pnpm-workspace.yaml`, then run the command again.

The bundle inserts the plugin disabled. Enable it in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-superagent-linear
  disabled: false
```

## Linear app

Use a Linear OAuth app with the client credentials grant, acting as an app user. Each token request asks for exactly `read,write,app:assignable,app:mentionable`. Linear revokes an app's existing client-credential tokens when a request names another scope, so other services that use the same app must request the same string. Tokens last 30 days; the Source keeps one in memory and requests a new one when Linear refuses it.

Linear keeps at most 1,000 tokens per app and evicts the least recently used, so the Source requests at most one token per 15 minutes: a token Linear refuses right after it was issued makes the Source's health an error until the window passes, instead of requesting new tokens that could evict another service's.

The client id and secret are read from files, such as a mounted Kubernetes Secret, on every token request. They are never put in environment variables, Trigger text or worker sandboxes. The file paths are account fields: dsh-superagent from c8f41c3 refuses a main-Session tool's change to them; only the panel and the plugin configuration may set them.

## Configuration

Set these on the Linear Source in the panel, or in the plugin configuration's `managed.sources.linear.config`:

| Key | Meaning |
| --- | --- |
| `clientIdFile`, `clientSecretFile` | Absolute paths of the files holding the app's client id and secret |
| `teams` | `[{ key or id, repository, projects, enabled }]`: the teams whose sessions are received, each by its key (such as `ENG`) or id. An entry with an id matches that team only, with its key as its name; a key alone matches whichever team holds it; `enabled` defaults to on. Each team is one row of the Source's admission table. A team Linear does not know is left out, and the Source's health says so |
| `teams[].repository` | The repository the team's Issues work in, unless their project names another: the GitHub Source's `repository` or one of its `repositories`, compared ignoring case. Optional when `projects` is set |
| `teams[].projects` | `[{ id or name, repository }]`: a repository per Linear project of the team. Prefer project ids: an entry with an id matches that project only and survives a rename. An entry with only a name matches a project of that name, ignoring case, and stops matching once the project is renamed. An Issue in a listed project works in the project's repository, any other Issue in the team's. Not shown in the panel; editing the team there keeps them |

A team needs a `repository`, `projects`, or both. A team or project whose repository the GitHub Source does not list is left out, and the Source's health names it (`ENG/Mobile` for a project).

```yaml
teams:
  - key: ENG
    repository: acme/web          # Issues without a listed project
    projects:
      - id: 6a1d3f0e-9c2b-4e57-8f13-2b0c7d9e4a61
        repository: acme/api
      - name: Mobile
        repository: acme/mobile
```

| `pollSeconds` | Polling interval, default 10; see Rate limits |
| `webhookSecretFile` | Absolute path of the file holding the app webhook's signing secret; empty polls only. See Webhook |
| `completeOnMerge` | Move the Issue to its team's first completed state once the ticket's own pull request merged, unless it is completed already; default on |

In the Policy, list the Linear user ids who may originate work under **Eval → On each Source → Linear**. A listed person's session is an explicit request; anyone else's is ignored with the default admission table. The app's own sessions and activities never become Triggers, and comments that do not address the app are not read.

## Behaviour

- **Intake.** Each round reads the sessions created since its cursor, then the prompt activities people wrote since its cursor, oldest first. A cursor moves only once every item it passes was taken in, and Trigger ids (`linear:session:<id>`, `linear:prompt:<id>`) make a replay harmless. The first round after the Source is switched on starts from that moment.
- **Answering at once.** Linear expects an agent to answer a session within about 10 seconds, so a new session on a listed team gets an ephemeral thought, "Received.", when the Source first sees it. The Source cannot read the Policy, so this also answers a session that a person off the allowed list started; nothing else follows for them.
- **Order.** Linear's `agentSessions` takes no filter, so each round reads pages of 25 until one reaches the cursor (newest first, Linear's default) or, for pages that come oldest first, to the end, at most 250 sessions. Prompts are filtered by time. A cursor never moves back, and a round with nothing new leaves it where it is.
- **Repositories.** An Issue's repository is its project's when the team lists that project, else the team's. Sessions and prompts are read with the Issue's project, so this costs no extra request. A Trigger whose repository is one of the GitHub Source's additional `repositories` carries `meta.repository`, that repository's name as the deployment lists it, so its ticket works there. Triggers on the primary `repository` carry none and are the same as before. Only a new session is routed by the Issue's current team and project. A prompt on an Issue with an open ticket, a stop included, follows that ticket: it carries the ticket's repository and is taken in even when the Issue has since moved to an unmapped project, one on an unlisted repository, or another team. Issues whose repository the GitHub Source does not list are left out, and the Source's health names them. With a dsh-superagent that has no `repositories`, only the primary is served.
- **No repository.** An Issue of a team without a `repository`, in a project the team does not list, is not taken in. Its session gets one `error` activity saying so, such as "Not taken in: team ENG names no repository for project Design.", and the Source's health lists the Issue under "no repository for".
- **Threads.** A Linear Issue is one Thread (`linear:issue:<issue id>`); later sessions on the same Issue follow its ticket.
- **Stop.** A prompt with Linear's stop signal becomes a Trigger whose text starts with "Stop requested in Linear."
- **Removed delegation.** While a ticket that started on Linear is open, the Source reads its Issue's delegate (`Issue.delegate`) at most every 30 seconds, one query for all open tickets. When an Issue that was delegated to the app no longer is, because someone removed the app or delegated another agent, the ticket gets a stop Trigger with the same "Stop requested in Linear." text and the ticket's repository in `meta.repository` when it is an additional one, attributed to the person in the Issue's history (`fromDelegate`) when a change since the ticket started shows it, and to no one otherwise. An Issue the query does not return, such as an archived or deleted one, or one in a chunk of 50 that failed, is left for the next check. A ticket that started from a mention, without delegation, keeps running unless the Issue is delegated to the app and that is later removed.
- **Closed Issue.** The same query reads the Issue's state for each ticket that started on Linear, open or ended within the last 14 days, until its Issue is known to be closed. Once the state's type is `completed` or `canceled`, the Source tells dsh-superagent, which archives the ticket's worker Session once the ticket has ended and restores it if a person's message resumes the ticket. With `completeOnMerge`, the Source's own completion of the Issue counts too.
- **Replies.** An acknowledgement or a notice is a `thought`, a reply a `response`, both in the session. Each activity's id is fixed by the message id, so a retry never posts twice; a session Linear no longer has drops the message.
- **Pull requests.** When a ticket that started on Linear follows a GitHub pull request, its link is added to the session's external URLs (`agentSessionUpdate`, `addedExternalUrls`), labelled `Pull request #12` in the ticket's repository and `Pull request owner/name#12` in another. Its merge ends the ticket through the GitHub Source as usual.
- **Execution environment.** `DSH_SUPERAGENT_LINEAR_ISSUE` (such as `ENG-12`) and `DSH_SUPERAGENT_LINEAR_ISSUE_URL`. A PR body with `Fixes ENG-12` lets Linear's GitHub integration close the Issue too.

- **Webhook.** With `webhookSecretFile` set, `POST /hooks/linear` on DSH's Web server takes Linear's deliveries. A delivery whose `Linear-Signature` (HMAC-SHA256 of the body with the secret) and `webhookTimestamp` (within a minute) check out gets 200 and wakes the polling for an immediate round; the payload itself is not taken in, so intake stays the API read above. Other methods get 405, a body over 1 MiB 413, a missing secret 503, a bad signature 401; a signed delivery over a minute old gets 200 without waking, as Linear may retry with the first attempt's timestamp. Rounds woken by deliveries start at least 2 seconds apart. The route needs no sign-in; expose only that path publicly.

**Keep the app's webhook enabled with Agent session events.** Linear creates no agent sessions for an app whose webhook is off, so delegations and mentions silently stop reaching the Source even though polling still runs.

Not implemented: thread context for assessments.

## Rate limits

Linear allows an OAuth app 5,000 requests and 2,000,000 complexity points per hour, per app user, shared by every service that uses the same app. A round costs two queries of about 200 points each, plus a team list every ten minutes and, while tickets that started on Linear are open or their Issue is still open, one Issue query every 30 seconds. At the default 10 seconds that is about 730 requests (15%) and 140,000 points (7%) per hour, and at most 120 requests (2.4%) more while tickets run. A longer interval lowers both and delays the first answer: past about 10 seconds Linear may show a session as unresponsive until the thought arrives. When Linear rate-limits the app, the Source sends nothing until the limit resets.

Linear recommends webhooks over polling. With the webhook wired up, `pollSeconds` can go up, as each delivery wakes the polling at once.

A Source package's schema errors come from its own copy of zod; dsh-superagent from c8f41c3 still answers them as validation errors (400) in the panel.

## Development

```sh
pnpm install
pnpm check
```

Tests stub `fetch`; they never call Linear.
