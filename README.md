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
| `teams` | `[{ key or id, repository, enabled }]`: the teams whose sessions are received, each by its key (such as `ENG`) or id, and the repository it works in. An entry with an id matches that team only, with its key as its name; a key alone matches whichever team holds it; `enabled` defaults to on. Each team is one row of the Source's admission table. A team whose `repository` is not the GitHub Source's repository, or that Linear does not know, is left out, and the Source's health says so |
| `pollSeconds` | Polling interval, default 10; see Rate limits |
| `completeOnMerge` | Move the Issue to its team's first completed state once the ticket's own pull request merged, unless it is completed already; default on |

In the Policy, list the Linear user ids who may originate work under **Eval → On each Source → Linear**. A listed person's session is an explicit request; anyone else's is ignored with the default admission table. The app's own sessions and activities never become Triggers, and comments that do not address the app are not read.

## Behaviour

- **Intake.** Each round reads the sessions created since its cursor, then the prompt activities people wrote since its cursor, oldest first. A cursor moves only once every item it passes was taken in, and Trigger ids (`linear:session:<id>`, `linear:prompt:<id>`) make a replay harmless. The first round after the Source is switched on starts from that moment.
- **Answering at once.** Linear expects an agent to answer a session within about 10 seconds, so a new session on a listed team gets an ephemeral thought, "Received.", when the Source first sees it. The Source cannot read the Policy, so this also answers a session that a person off the allowed list started; nothing else follows for them.
- **Order.** Linear's `agentSessions` takes no filter, so each round reads pages of 25 until one reaches the cursor (newest first, Linear's default) or, for pages that come oldest first, to the end, at most 250 sessions. Prompts are filtered by time. A cursor never moves back, and a round with nothing new leaves it where it is.
- **Teams on another repository.** Sessions of a listed team whose repository is not the GitHub Source's are left out, and the Source's health names them.
- **Threads.** A Linear Issue is one Thread (`linear:issue:<issue id>`); later sessions on the same Issue follow its ticket.
- **Stop.** A prompt with Linear's stop signal becomes a Trigger whose text starts with "Stop requested in Linear."
- **Removed delegation.** While a ticket that started on Linear is open, the Source reads its Issue's delegate (`Issue.delegate`) at most every 30 seconds, one query for all open tickets. When an Issue that was delegated to the app no longer is, because someone removed the app or delegated another agent, the ticket gets a stop Trigger with the same "Stop requested in Linear." text, attributed to the person in the Issue's history (`fromDelegate`) when a change since the ticket started shows it, and to no one otherwise. An Issue the query does not return, such as an archived or deleted one, or one in a chunk of 50 that failed, is left for the next check. A ticket that started from a mention, without delegation, keeps running unless the Issue is delegated to the app and that is later removed.
- **Replies.** An acknowledgement or a notice is a `thought`, a reply a `response`, both in the session. Each activity's id is fixed by the message id, so a retry never posts twice; a session Linear no longer has drops the message.
- **Pull requests.** When a ticket that started on Linear follows a GitHub pull request, its link is added to the session's external URLs (`agentSessionUpdate`, `addedExternalUrls`). Its merge ends the ticket through the GitHub Source as usual.
- **Execution environment.** `DSH_SUPERAGENT_LINEAR_ISSUE` (such as `ENG-12`) and `DSH_SUPERAGENT_LINEAR_ISSUE_URL`. A PR body with `Fixes ENG-12` lets Linear's GitHub integration close the Issue too.

Not implemented: webhooks, thread context for assessments, and more than one repository.

## Rate limits

Linear allows an OAuth app 5,000 requests and 2,000,000 complexity points per hour, per app user, shared by every service that uses the same app. A round costs two queries of about 200 points each, plus a team list every ten minutes and, while tickets that started on Linear are open, one delegate query every 30 seconds. At the default 10 seconds that is about 730 requests (15%) and 140,000 points (7%) per hour, and at most 120 requests (2.4%) more while tickets run. A longer interval lowers both and delays the first answer: past about 10 seconds Linear may show a session as unresponsive until the thought arrives. When Linear rate-limits the app, the Source sends nothing until the limit resets.

Linear recommends webhooks over polling. This Source polls so it needs no public endpoint; an app has one webhook URL, and a webhook intake could replace polling later.

A Source package's schema errors come from its own copy of zod; dsh-superagent from c8f41c3 still answers them as validation errors (400) in the panel.

## Development

```sh
pnpm install
pnpm check
```

Tests stub `fetch`; they never call Linear.
