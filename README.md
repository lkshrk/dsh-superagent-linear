# dsh-superagent-linear

A Linear Source for [dsh-superagent](https://github.com/lkshrk/dsh-superagent).

A Linear agent app's sessions on the configured teams become dsh-superagent Triggers. A person delegates an Issue to the app, or mentions the app in a comment, and a session starts. Later prompts in the same session follow. dsh-superagent's replies go back into the session as agent activities.

The Source also:

- puts the Issue's parent and sub-issues on top of the Trigger text;
- works through an Issue's sub-issues, one session each, in the order their `blocks` relations allow (chain mode);
- asks for a plan when an Issue labelled `epic` has no sub-issues yet (split mode);
- links pull requests into the session and completes the Issue once the ticket's own pull request merged;
- stops a ticket when the app is removed as the Issue's delegate.

More detail:

- [Architecture](docs/architecture.md): components, the polling round, stored state.
- [Configuration](docs/configuration.md): every key, team and project matching, the Policy, the execution environment.
- [Linear integration](docs/linear-integration.md): the Linear app, GraphQL operations, webhook, rate limits.

## Requirements

- dsh `^0.2.1-alpha.2 || ^0.2.2-0` with the dsh-superagent plugin. The Source registers through dsh-superagent's `orchestrator` service.
- Node.js `^22.19.0 || >=24.0.0`.
- A Linear OAuth app that uses the client credentials grant and acts as an app user. See [The Linear app](docs/linear-integration.md#the-linear-app).
- dsh-superagent's GitHub Source, configured with every repository the Linear teams work in.

A Source kind is registered once per dsh-superagent. Install the package once.

## Install

```sh
dsh plugin --profile <profile> add "github:lkshrk/dsh-superagent-linear#<commit>"
```

pnpm builds a Git install through the `prepare` script and blocks it until you allow it. Add the key pnpm prints under `allowBuilds` in the profile's `pnpm-workspace.yaml`, then run the command again:

```yaml
allowBuilds:
  dsh-superagent-linear@https://codeload.github.com/lkshrk/dsh-superagent-linear/tar.gz/<commit>: true
```

The package's bundle layer (`cordis.patch.yml`) inserts the plugin disabled. Enable it in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-superagent-linear
  disabled: false
```

## Configure

Set the Source in the dsh-superagent panel, or in dsh-superagent's plugin configuration under `managed`:

```yaml
managed:
  sources:
    linear:
      config:
        clientIdFile: /var/run/secrets/linear-app/client-id
        clientSecretFile: /var/run/secrets/linear-app/client-secret
        webhookSecretFile: /var/run/secrets/linear-app/webhook-secret
        teams:
          - key: ENG
            repository: acme/web
            projects:
              - id: 6a1d3f0e-9c2b-4e57-8f13-2b0c7d9e4a61
                repository: acme/api
  policy:
    sources:
      linear:
        allowed:
          - id: <Linear user id>
            name: Alice
```

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `clientIdFile` | absolute path | `''` | File with the app's client id. Required. |
| `clientSecretFile` | absolute path | `''` | File with the app's client secret. Required. |
| `webhookSecretFile` | absolute path | `''` | File with the webhook signing secret. Empty means polling only. |
| `teams` | list | `[]` | Teams whose sessions are taken in, each with a repository, projects, or both. At least one enabled team is required. |
| `pollSeconds` | integer, 5–600 | `10` | Seconds between polling rounds. |
| `completeOnMerge` | boolean | `true` | Complete the Issue once the ticket's own pull request merged. |
| `chainParallel` | integer, 1–8 | `2` | Sub-issues worked on at once, across all chains. |

[Configuration](docs/configuration.md) explains each key in full.

Only people in the Policy's `allowed` list originate work. With the default admission table, a session from anyone else is ignored.

The Source stays `paused` until both credential files and at least one enabled team are set.

## How it works

Each polling round runs these steps in order:

1. Read new agent sessions since the session cursor.
2. Read new prompt activities since the prompt cursor.
3. Link pull requests and complete merged Issues for tickets that started on Linear.
4. At most every 30 seconds: check re-delegated Issues, then the delegate and state of the Issues of those tickets.
5. Advance active chains.

The first round after the Source is switched on only sets both cursors to now. Older sessions are not work for it.

A signed webhook delivery ends the wait between rounds early. See [Webhook](#webhook).

### Triggers

| Trigger id | Comes from |
| --- | --- |
| `linear:session:<session id>` | A person's new session: a delegation or a mention. |
| `linear:prompt:<activity id>` | A person's prompt in a session. |
| `linear:undelegated:<history id>` | The app was removed as the delegate of an Issue with an open ticket. |
| `linear:chain:<run>:<sub-issue id>` | A chain started a sub-issue. |
| `linear:chain-stop:<run>:<sub-issue id>` | A chain stopped while the sub-issue was started. |

The Thread is the Issue (`linear:issue:<issue id>`). The Channel is the session. Fixed ids make a replay after a failure harmless.

The app's own sessions and activities never become Triggers.

### Replies

A new session on a served team gets an ephemeral thought, "Received.", in the same round. Linear expects an agent to answer within seconds, and an evaluation takes longer.

dsh-superagent's messages go back as activities in the session:

| Message kind | Activity type |
| --- | --- |
| `acknowledgement` | `thought` |
| `notice` | `thought` |
| `reply` | `response` |

Each activity id derives from the message id, so a retry never posts twice. A message to a session Linear no longer has is dropped.

### Repositories

An Issue works in its project's repository when the team lists that project, else in the team's repository. The repository must be one the GitHub Source serves.

- A team or project on a repository the GitHub Source does not list is skipped. Health names it.
- An Issue with no repository at all is not taken in. Its session gets one `error` activity, such as "Not taken in: team ENG names no repository for project Design."
- A prompt on an Issue with an open ticket follows that ticket's repository, even after the Issue moved to another project or team.

### Stop and undelegation

A prompt with Linear's `stop` signal becomes a Trigger whose text starts with "Stop requested in Linear."

While a ticket that started on Linear is open, the Source checks its Issue's delegate at most every 30 seconds. When an Issue that was delegated to the app no longer is, the ticket gets a stop Trigger. A ticket that started from a mention keeps running, unless the Issue is later delegated to the app and that delegation is removed.

### Pull requests and closed Issues

- Each pull request a ticket follows is added to the session's external links, labelled `Pull request #12` in the ticket's repository and `Pull request owner/name#12` in another.
- With `completeOnMerge`, the Issue moves to its team's first completed state once the ticket's own pull request merged.
- When an Issue moves to a completed or canceled state, the Source reports it to dsh-superagent. This covers open tickets and tickets that ended within the last 14 days.

## Epics

The Source treats an Issue with sub-issues as an epic. The `epic` label matters for split mode and for answering prompts.

### Split mode

A new session on an Issue labelled `epic` (any case) that has no sub-issues gets this first line:

```text
Mode: split (plan this epic into sub-issues; no code)
```

The worker sees `DSH_SUPERAGENT_LINEAR_MODE=split`. The Source does not create sub-issues itself.

### Chain mode

A person delegates an Issue with sub-issues to the app. The Issue never gets a worker of its own. A chain starts instead:

1. The epic's session gets a plan listing the sub-issues.
2. The Source opens an app session on each ready sub-issue and takes it in as a chain Trigger from the person who delegated the epic. A sub-issue is ready when each of its `blocks` blockers is completed or canceled.
3. Ready sub-issues start in sub-issue order, while fewer than `chainParallel` run across all chains.
4. A sub-issue assigned to a person is left alone. The chain waits for it.
5. Once every sub-issue is completed or canceled, the Source completes the epic and lists the sub-issues and their pull requests in its session.

Other ways to start a chain:

- Write a message such as "start" in the session of a delegated epic that has open sub-issues and no running chain.
- Delegate an epic the Source already knows to the app again. Linear reuses the old session, so the Source finds the re-delegation in the Issue's history. A delegation made by an automation or integration does not start a chain; write "start" instead.

A mention of an epic, or a prompt while a chain runs, gets a thought with the chain's status. A stop in the epic's session ends the chain.

A chain stops when:

- a sub-issue's ticket ended while the sub-issue is still open;
- a sub-issue got no ticket within 30 minutes;
- nothing running can unblock the rest, such as a cycle or a blocker outside the epic;
- the epic is no longer delegated to the app, or was completed or canceled;
- the epic has more than 30 sub-issues, or a sub-issue more than 20 relations;
- a sub-issue works in no repository the deployment serves, or the admission table filters it;
- a person sends a stop in the epic's session.

Started sub-issues then get a stop Trigger, and the epic's session gets the reason. A new run skips completed sub-issues and keeps the ones still running.

## Webhook

With `webhookSecretFile` set, `POST /hooks/linear` on DSH's web server takes Linear's deliveries. A valid delivery only wakes the polling loop for an immediate round. Intake still reads the Linear API.

The plugin checks each delivery's `Linear-Signature` and does no other authentication. Expose only that path publicly. See [Webhook](docs/linear-integration.md#webhook).

Keep the app's webhook enabled with agent session events. Linear creates no agent sessions for an app whose webhook is off, so delegations and mentions stop arriving even though polling still runs.

## Troubleshooting

The Source reports one health entry, `linear`. Its detail lists the round's counts and problems.

| Health detail | Meaning |
| --- | --- |
| `Waiting for the deployment check` | dsh-superagent's deployment is not configured. The polling loop exits. |
| `Off` | The Source is switched off. |
| `Set the app credential files and a team` | A credential file path is empty, or no team is enabled. |
| `teams … skipped: their repository is not one the GitHub Source serves` | Add the repository to the GitHub Source, or fix the team or project. Health is `error`. |
| `teams … not found in Linear` | The team key or id is wrong, or the app cannot see the team. Health is `error`. |
| `teams unverified` | The team list could not be read. Intake goes on. |
| `left out …` | These Issues' repository is not one the GitHub Source serves. |
| `no repository for …` | Map the Issue's project, or give the team a `repository`. |
| `parent and sub-issues unreadable: n` | Context reads failed. Sessions were taken in without context. |
| `sub-issue chains not advanced: n` | A chain or re-delegation read failed. It retries next round. |
| `n failed polls in a row` | Three rounds failed in a row, or a refused token or rate limit blocks every request. Health is `error`. |

Common causes:

- **No sessions arrive.** Check that the app's webhook is enabled with agent session events, and that the person is in the Policy's `allowed` list.
- **"Linear refused the token minted n min ago".** Linear rejected a fresh token. The Source waits up to 15 minutes before it asks for another, so it does not evict other services' tokens. Check the credentials and the scope other services request with the same app.
- **"The Linear app credential files are not readable".** Check the paths and file permissions.
- **"Linear's rate limit holds requests until …".** The app hit Linear's rate limit. Requests resume after the reset. Raise `pollSeconds`, or configure the webhook and then raise it.
- **A delegated epic does nothing.** When its sub-issues cannot be read, the session waits up to 10 minutes, then gets an error. Write "start" in the session to retry.

## Development

```sh
pnpm install
pnpm check
```

| Script | Runs |
| --- | --- |
| `pnpm build` | `tsdown`: bundles `src/index.ts` into `lib/` as ESM with type declarations. |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | `vitest run` over `tests/**/*.spec.ts` |
| `pnpm check` | Typecheck, test and build, in that order. |

Tests stub `fetch`. They never call Linear.

## License

MIT
