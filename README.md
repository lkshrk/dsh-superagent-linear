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

The client id and secret are read from files, such as a mounted Kubernetes Secret, on every token request. They are never put in environment variables, Trigger text or worker sandboxes.

## Configuration

Set these on the Linear Source in the panel, or in the plugin configuration's `managed.sources.linear.config`:

| Key | Meaning |
| --- | --- |
| `clientIdFile`, `clientSecretFile` | Absolute paths of the files holding the app's client id and secret |
| `teams` | `[{ key or id, repository, enabled }]`: the teams whose sessions are received, each by its key (such as `ENG`) or id, and the repository it works in; `enabled` defaults to on. Each team is one row of the Source's admission table. A team whose `repository` is not the GitHub Source's repository, or that Linear does not know, is left out, and the Source's health says so |
| `pollSeconds` | Polling interval, default 10 |
| `completeOnMerge` | Move the Issue to its team's first completed state once the ticket's own pull request merged, unless it is completed already; default on |
| `apiUrl`, `tokenUrl` | Linear's endpoints; change only for tests |

In the Policy, list the Linear user ids who may originate work under **Eval → On each Source → Linear**. A listed person's session is an explicit request; anyone else's is ignored with the default admission table. The app's own sessions and activities never become Triggers, and comments that do not address the app are not read.

## Behaviour

- **Intake.** Each round reads the sessions created since its cursor, then the prompt activities people wrote since its cursor, oldest first. A cursor moves only once every item it passes was taken in, and Trigger ids (`linear:session:<id>`, `linear:prompt:<id>`) make a replay harmless. The first round after the Source is switched on starts from that moment.
- **Answering at once.** Linear marks a session unresponsive when nothing answers within seconds, so a new session on a listed team gets an ephemeral thought, "Received; looking into it.", when the Source first sees it.
- **Threads.** A Linear Issue is one Thread (`linear:issue:<issue id>`); later sessions on the same Issue follow its ticket.
- **Stop.** A prompt with Linear's stop signal becomes a Trigger whose text starts with "Stop requested in Linear."
- **Replies.** An acknowledgement or a notice is a `thought`, a reply a `response`, both in the session. Each activity's id is fixed by the message id, so a retry never posts twice; a session Linear no longer has drops the message.
- **Pull requests.** When a ticket that started on Linear follows a GitHub pull request, its link is added to the session's external URLs (`agentSessionUpdate`, `addedExternalUrls`). Its merge ends the ticket through the GitHub Source as usual.
- **Execution environment.** `DSH_SUPERAGENT_LINEAR_ISSUE` (such as `ENG-12`) and `DSH_SUPERAGENT_LINEAR_ISSUE_URL`. A PR body with `Fixes ENG-12` lets Linear's GitHub integration close the Issue too.

Not implemented: webhooks, thread context for assessments, and more than one repository.

## Development

```sh
pnpm install
pnpm check
```

Tests stub `fetch`; they never call Linear.
