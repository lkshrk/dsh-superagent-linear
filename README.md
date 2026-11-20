# dsh-superagent-linear

A Linear Source for [dsh-superagent](https://github.com/lkshrk/dsh-superagent).

A Linear agent app's sessions on the configured teams become dsh-superagent Triggers. A person delegates an Issue to the app, or mentions the app in a comment, and a session starts. Later prompts in the same session follow. dsh-superagent's replies go back into the session as agent activities.

The Source also:

- puts the Issue's parent and sub-issues on top of the Trigger text;
- works through an Issue's sub-issues, one session each, in the order their `blocks` relations allow (chain mode);
- asks a worker to plan an Issue labelled `epic` that has no sub-issues yet (split mode);
- links pull requests into the session and completes the Issue once the ticket's own pull request merged;
- stops a ticket when the app is removed as the Issue's delegate.

More detail:

- [Architecture](docs/architecture.md): components, the polling round, stored state.
- [Configuration](docs/configuration.md): every key, team and project matching, the Policy, the execution environment.
- [Linear integration](docs/linear-integration.md): the Linear app, GraphQL operations, webhook, rate limits.

## Requirements

- dsh `^0.2.1-alpha.2 || ^0.2.2-0` with the dsh-superagent plugin. The Source registers through dsh-superagent's `orchestrator` service.
- For chain mode: dsh-superagent from commit `e16b265` (lkshrk/dsh-superagent), whose Source context offers `admits`. On an older one, nobody can start or stop a chain, and health says so.
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
| `completeOnMerge` | boolean | `true` | Complete the Issue once the ticket's own pull request merged. Chains need sub-issues closed this way or by hand. |
| `chainParallel` | integer, 1–8 | `2` | Sub-issues worked on at once, across all chains. |

[Configuration](docs/configuration.md) explains each key in full.

Only people in the Policy's `allowed` list originate work. With the default admission table, a session from anyone else is ignored. Only they can start or stop a chain of sub-issues.

The Source stays `paused` until both credential files and at least one enabled team are set.

### Finding ids and the webhook URL

The Linear GraphQL API returns the ids the config needs. Run these queries in Linear's API explorer or with a personal API key:

| You need | Query |
| --- | --- |
| A person's user id, for `allowed` | `query { users { nodes { id name email } } }` |
| A team id and key | `query { teams { nodes { id key name } } }` |
| A project id | `query { projects { nodes { id name } } }` |

In the Linear app's webhook settings, set the URL to `https://<public host of DSH's web server>/hooks/linear`, enable agent session events, and put the signing secret Linear shows into the file `webhookSecretFile` names.

## How it works

Each polling round runs these steps in order:

1. Read new agent sessions since the session cursor.
2. Read new prompt activities since the prompt cursor.
3. Link pull requests and complete merged Issues for tickets that started on Linear.
4. At most every 30 seconds: check re-delegated Issues, then the delegate and state of the Issues of those tickets.
5. Advance active chains.

Both cursors persist in the Source's state. The very first round, with no cursor stored yet, only sets both to now: older sessions are not work for it. After the Source is paused or switched off and on again, the next round reads everything since the stored cursors.

A round reads at most 10 pages of 25 per query. When more items arrived since the cursor, the Source stores where it stopped (`linear-sessions-backlog`, `linear-prompts-backlog`) and does not move the cursor. The next round reads on from there, until it reaches the cursor; then the cursor moves past the newest item seen. A backlog survives token and server outages. It is dropped only when Linear refuses its page cursor; the read then starts again from the newest page.

A signed webhook delivery ends the wait between rounds early. See [Webhook](#webhook).

### Triggers

| Trigger id | Comes from |
| --- | --- |
| `linear:session:<session id>` | A person's new session: a delegation or a mention. |
| `linear:prompt:<activity id>` | A person's prompt in a session. |
| `linear:delegation:<history id>` | A person delegated an Issue without sub-issues to the app again, and Linear reused its old session. |
| `linear:undelegated:<history id>` | The app was removed as the delegate of an Issue with an open ticket. Without a matching history entry the id is `linear:undelegated:<ticket id>:<time observed>`. |
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
- An Issue whose repository the GitHub Source does not serve is not taken in. Its session gets one `error` activity, such as "Not taken in: ENG-12 works in acme/legacy, which this deployment does not serve."
- An Issue with no repository at all is not taken in. Its session gets one `error` activity, such as "Not taken in: team ENG names no repository for project Design."
- A prompt routed either way gets the same kind of `error` activity, once per prompt.
- A prompt on an Issue with an open ticket follows that ticket's repository, even after the Issue moved to another project or team.

### Prompts

A prompt on an Issue with an open ticket goes to that ticket as written. A prompt on an Issue without one starts a new ticket. Its text is the prompt first, then `(ENG-12: title)` and the Issue's description, because the worker cannot read the Issue itself.

### Linked documents

An Issue often links its design as a Linear document. The Source reads the Issue's description for links of the form `https://linear.app/<workspace>/document/<slug>-<id>` and puts each document's id into the Trigger's `meta.documents`: the 12 hex characters that end the link, in lower case, each once, the first 20. Every Trigger built from an Issue carries them: a session, a prompt, a re-delegation and a chain sub-issue.

dsh-superagent lets the ticket's worker call the `linear` MCP server's `get_document` for exactly these documents, and for no other (see dsh-superagent's deployment docs). A split worker gets no `get_document`. An older dsh-superagent ignores the field.

Only the description counts. A link in the session's comment, in a prompt or in another comment gives the worker nothing: the description is the Issue's own text, and the list is taken once, when the Trigger is built. To let a worker read a document, link it in the description before delegating.

### Re-delegation

Linear opens a session only on an Issue's first delegation and reuses it afterwards. When a person delegates an Issue without sub-issues to the app again, the Source finds the delegation in the Issue's history and starts a run like a first delegation: a new app session on the Issue, "Received.", and a Trigger with the Issue's subject and description. It waits 60 seconds first, and starts nothing when a session for that delegation arrived meanwhile; both times are Linear's. A re-delegation made while an earlier ticket of the Issue is still open, such as undelegating and delegating again to restart, waits until that ticket ended and then starts one run, unless the Issue was completed or canceled by then; a session already opened for it then says so. Like a first delegation, a re-delegation that did not wait still starts on a completed or canceled Issue. It starts nothing when the Issue routes to no served repository, or when it is no longer delegated to the app. A person not on the Linear Source's allowed list gets the refusal in the Issue's known session, if the Source knows one. A delegation by an automation, an integration or an app starts nothing, and neither does one made before the Source's first check.

The Issue's sub-issues are read before the Trigger. When that read fails, the start is retried on the next check in the same session. When the Issue has sub-issues by then, its session says so instead. When the Issue moved to a team or project this deployment does not serve after its session was opened, the session gets an `error` activity. A start that keeps failing is given up 24 hours after the delegation, with a log line.

Re-delegating an epic whose sub-issues are all closed starts nothing; its known session says so.

### Stop and undelegation

A prompt with Linear's `stop` signal becomes a Trigger whose text starts with "Stop requested in Linear."

While a ticket that started on Linear is open, the Source checks its Issue's delegate at most every 30 seconds. When an Issue that was delegated to the app no longer is, the ticket gets a stop Trigger. A ticket that started from a mention keeps running, unless the Issue is later delegated to the app and that delegation is removed.

### Pull requests and closed Issues

- Each pull request a ticket follows is added to the session's external links, labelled `Pull request #12` in the ticket's repository and `Pull request owner/name#12` in another.
- With `completeOnMerge`, the Issue moves to its team's first completed state once the ticket's own pull request merged.
- When an Issue moves to a completed or canceled state, the Source reports it to dsh-superagent. This covers open tickets and tickets that ended within the last 14 days. It needs a dsh-superagent whose Source context offers `tickets.issueClosed`; on an older one the Source does not watch for closes.

## Epics

The Source treats an Issue with sub-issues as an epic. The `epic` label matters for split mode and for answering prompts.

### Split mode

A new session on an Issue labelled `epic` (any case) that has no sub-issues gets this first line:

```text
Mode: split (plan this epic into sub-issues; no code)
```

The worker sees `DSH_SUPERAGENT_LINEAR_MODE=split`. The Source does not create sub-issues itself. The worker creates them through the `linear` MCP server's `save_issue`, so workers need that MCP server. dsh-superagent gives `save_issue` only to a split worker, and only for sub-issues of that epic (see dsh-superagent's deployment docs).

### Chain mode

A person delegates an Issue with sub-issues to the app. The Issue never gets a worker of its own. A chain starts instead:

1. The epic's session gets a plan listing the sub-issues.
2. The Source opens an app session on each ready sub-issue and takes it in as a chain Trigger from the person who delegated the epic. A sub-issue is ready when each of its `blocks` blockers is completed or canceled.
3. Ready sub-issues start in sub-issue order, while fewer than `chainParallel` run across all chains.
4. A sub-issue assigned to a person is left alone. The chain waits for it.
5. Once every sub-issue is completed or canceled, the Source completes the epic and lists the sub-issues and their pull requests in its session. This also holds when Linear closed the epic with its last sub-issue, or removed the app as its delegate as it did.

When nothing can start and the only open sub-issues are assigned to someone else, the epic's session gets one notice: "Waiting for ENG-13, assigned to someone else; the chain goes on once they close." A `blocks` blocker the app cannot read counts as open.

The Source completes only the epic. Each sub-issue must be closed by `completeOnMerge`, by Linear's GitHub integration (`Fixes ENG-12` in the pull request), or by a person. A sub-issue whose ticket ends while it is still open stops the chain with "ENG-12 ended without being completed".

Other ways to start a chain:

- Write exactly `start` (any case) in the session of a delegated epic that has open sub-issues and no running chain. Any other message gets the chain's status.
- Delegate an epic the Source already knows to the app again. Linear reuses the old session, so the Source finds the re-delegation in the Issue's history. A delegation made by an automation or integration does not start a chain; write `start` instead.

A mention of an epic, or a prompt while a chain runs, gets a thought with the chain's status. A stop in the epic's session ends the chain.

Only users on the Linear Source's allowed list can start or stop a chain: by delegating, re-delegating, writing `start`, or sending a stop. The Source asks dsh-superagent through `admits`. Anyone else gets "Only users on the Linear Source's allowed list can start or stop a chain of sub-issues." Without `admits`, nobody can, and health says "nobody can start or stop a sub-issue chain: this dsh-superagent version cannot check the Linear policy".

A chain stops when:

- a sub-issue's ticket ended while the sub-issue is still open;
- a sub-issue got no ticket within 30 minutes;
- nothing running can unblock the rest, such as a cycle, a blocker outside the epic, or a blocker the app cannot read ("stalled: ENG-13 waits for ENG-12");
- the epic was delegated to the app and no longer is, while sub-issues are still open;
- the epic was completed or canceled while sub-issues are still open, or has no sub-issues left;
- the epic has more than 30 sub-issues, or a sub-issue more than 20 relations;
- a sub-issue works in no repository the deployment serves, or the admission table filters it;
- a person sends a stop in the epic's session.

Started sub-issues then get a stop Trigger, and the epic's session gets the reason. A new run skips completed sub-issues and keeps the ones still running.

## Webhook

With `webhookSecretFile` set, `POST /hooks/linear` on DSH's web server takes Linear's deliveries. The route needs DSH's optional `webServer` service; without it the Source polls only. A valid delivery only wakes the polling loop for an immediate round. Intake still reads the Linear API.

The plugin checks each delivery's `Linear-Signature` and does no other authentication. Expose only that path publicly. See [Webhook](docs/linear-integration.md#webhook).

Keep the app's webhook enabled with agent session events, also when you rely on polling. Linear may not open agent sessions for an app whose webhook is off; this is Linear's behaviour, not something the Source checks.

## Troubleshooting

The Source reports one health entry, `linear`. Its detail lists the round's counts and problems.

| Health detail | Meaning |
| --- | --- |
| `Waiting for the deployment check` | dsh-superagent's deployment is not configured. The polling loop exits. |
| `Off` | The Source is switched off. |
| `Set the app credential files and a team` | A credential file path is empty, or no team is enabled. |
| `teams … skipped: their repository is not one the GitHub Source serves` | Add the repository to the GitHub Source, or fix the team or project. Health is `error`. |
| `teams … not found in Linear` | The team key or id is wrong, or the app cannot see the team. Health is `error`. |
| `teams unverified: Linear's team list was not readable` | The team list could not be read. Intake goes on. |
| `left out …` | These Issues' repository is not one the GitHub Source serves. |
| `no repository for …` | Map the Issue's project, or give the team a `repository`. |
| `parent and sub-issues unreadable: n` | Context reads failed. The sessions are held; see below. A chain sub-issue whose context read failed is taken in without context. |
| `sub-issue chains not advanced: n` | A chain or re-delegation read failed. It retries next round. |
| `pull request links or Issue completions failing: n` | A follow-up failed. It retries each round for up to 24 hours after its first failure, then gives up with a log line. |
| `nobody can start or stop a sub-issue chain: …` | dsh-superagent is older than `e16b265` and has no `admits`. |
| `n failed polls in a row; last: <error>` | Three rounds failed in a row, or a refused token or rate limit blocks every request. Health is `error`. When held sessions failed the round, the detail ends with `; parent and sub-issues unreadable: n`. |

Common causes:

- **No sessions arrive.** Check that the app's webhook is enabled with agent session events, and that the person is in the Policy's `allowed` list.
- **"… n min ago; the next token request waits m min".** The Source asks for at most one token per 15 minutes, so it does not evict other services' tokens. The 15 minutes start only once the token endpoint answered or timed out. The message names that answer:
  - "The Linear token endpoint answered 401 0 min ago": the client id or secret is wrong. Linear answered 401, and the retry that follows hits the wait.
  - "The Linear token endpoint did not answer within 30 s": the endpoint timed out.
  - "The Linear token endpoint answered without a token": the answer had no `access_token`.
  - "Linear refused the token minted": Linear issued a token, then refused it.

  Check the credentials and the scope other services request with the same app. A fix takes effect when the wait ends, up to 15 minutes later.
- **"The Linear app credential files are not readable; the next round tries again".** Check the paths and file permissions. There is no wait.
- **"The Linear token endpoint was not reachable (…); the next round tries again".** A network error before Linear answered. There is no wait.
- **"Linear's rate limit holds requests until …".** The app hit Linear's rate limit. Requests resume after the reset. Raise `pollSeconds`, or configure the webhook and then raise it.
- **A session does nothing, and polls fail.** When the parent and sub-issues of a new session's Issue cannot be read, the Source cannot tell whether it is an epic. It holds the session, delegation or mention alike, for up to 10 minutes by failing the round, so the cursor stays put. A `start` prompt whose read fails is held the same way. After three rounds health is `error` with "last: Error: A Linear session or prompt was not taken in; the next round reads it again; parent and sub-issues unreadable: n". After 10 minutes the session gets an error activity and the cursor moves on. Its text says what to do: write exactly "start" in the session (a delegation), or mention the app again (a mention).

The log gets a "poll failed" line per failed round, except that a token wait or rate limit holding for many rounds logs it once. The health line is logged again only when its cause changes; for a token wait or rate limit, not as its minutes count down.

## Development

After cloning, run `mise install` and `lefthook install` once to get the pinned tools and the pre-commit and pre-push hooks.
mise takes Node from `.node-version`; run `corepack enable` once so pnpm comes from `packageManager` in `package.json`.

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

Pushing a tag `vX.Y.Z` equal to `v` plus the `version` in `package.json` runs `pnpm check` and attaches `dsh-superagent-linear-X.Y.Z.tgz` to the GitHub release for that tag.
It also pushes `ghcr.io/lkshrk/dsh-superagent-linear:X.Y.Z`, a `scratch` image for linux/amd64 and linux/arm64 that holds only that tarball at `/`, for mounting as a Kubernetes image volume; the release notes give its digest.

## License

MIT. See [LICENSE](LICENSE).
