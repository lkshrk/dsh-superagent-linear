# Configuration

The Source's config is validated by `LinearConfigSchema` in `src/linear.ts`. Unknown keys are rejected. Strings are trimmed.

Set it in the dsh-superagent panel under the Linear Source, or in dsh-superagent's plugin configuration at `managed.sources.linear.config`. The Policy lives at `managed.policy.sources.linear`.

## Keys

### `clientIdFile`, `clientSecretFile`

| | |
| --- | --- |
| Type | Absolute path, or empty |
| Default | `''` |
| Panel | "App client id file", "App client secret file" |

Files holding the Linear app's client id and secret, such as a mounted Kubernetes Secret. The client reads them on every token request, so a rotated secret takes effect on the next token. Both are required; while either is empty the Source is `paused`.

The values never reach environment variables, Trigger text or worker sandboxes.

### `webhookSecretFile`

| | |
| --- | --- |
| Type | Absolute path, or empty |
| Default | `''` |
| Panel | "Webhook signing secret file" (optional) |

File holding the Linear webhook's signing secret. The handler reads it on every delivery. Empty means polling only, and `/hooks/linear` answers `503`. See [Webhook](linear-integration.md#webhook).

The three file paths are account fields. Only the panel and the plugin configuration may change them, not a main-Session tool.

### `teams`

| | |
| --- | --- |
| Type | List of team entries |
| Default | `[]` |
| Panel | "Teams", with the columns key, id and repository |

The teams whose sessions the Source takes in. Each enabled team is one row of the Source's admission table.

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `key` | string | `''` | Team key, such as `ENG`. Compared ignoring case. |
| `id` | string | `''` | Linear team id. |
| `repository` | `owner/name`, or empty | `''` | Repository for the team's Issues that are in no listed project. |
| `projects` | list | `[]` | A repository per Linear project. Not shown in the panel; editing the team there keeps them. |
| `enabled` | boolean | `true` | A disabled team is ignored. Not shown in the panel. |

Each entry needs an `id` or a `key`, and a `repository`, `projects`, or both.

Team matching:

- An entry with an `id` matches that team only. A key can move to another team; an id cannot.
- An entry with only a `key` matches whichever team holds that key.
- The admission row and health use the entry's `key`, or its `id` when it has no key.

Every 10 minutes the Source reads the workspace's teams. An enabled entry Linear does not know is listed in health as "not found in Linear", and health is `error`.

#### `teams[].projects`

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `id` | string | `''` | Linear project id. |
| `name` | string | `''` | Project name, compared ignoring case. |
| `repository` | `owner/name` | required | Repository for the project's Issues. |

Each project needs an `id` or a `name`. Prefer ids: an entry with an id matches that project only and survives a rename. An entry with only a name stops matching once the project is renamed.

#### Routing

An Issue works in its project's repository when the team lists that project, else in the team's `repository`. Repository names are compared with the GitHub Source's `repository` and `repositories`, ignoring case. A Trigger on a repository other than the primary carries `meta.repository` with the name the deployment lists.

| Case | Result |
| --- | --- |
| The team or project names a repository the GitHub Source does not serve | Skipped. Health names the team, or `TEAM/<project name>` for a project (the project id when the entry has no name), and is `error`. |
| The Issue's repository is not served | Not taken in. Health lists the Issue as "left out". |
| Neither the project nor the team names a repository | Not taken in. The session gets one `error` activity. Health lists the Issue under "no repository for". |
| The Issue's team is not configured or is disabled | dsh-superagent's scope filter drops it (`team_not_listed`). |

Only a new session is routed by the Issue's current team and project. A prompt on an Issue with an open ticket follows that ticket, even after the Issue moved.

```yaml
teams:
  - key: ENG
    repository: acme/web          # Issues without a listed project
    projects:
      - id: 6a1d3f0e-9c2b-4e57-8f13-2b0c7d9e4a61
        repository: acme/api
      - name: Mobile
        repository: acme/mobile
  - id: 2b0c7d9e-4a61-4e57-8f13-6a1d3f0e9c2b
    key: OPS
    projects:                     # no team repository: other projects are not taken in
      - id: 8f132b0c-7d9e-4a61-9c2b-6a1d3f0e4e57
        repository: acme/infra
```

### `pollSeconds`

| | |
| --- | --- |
| Type | Integer, 5 to 600 |
| Default | `10` |
| Panel | "Polling interval / seconds" (advanced) |

Seconds between polling rounds. A longer interval costs fewer requests and delays the first answer. Linear may show a session as unresponsive until the "Received." thought arrives. With the webhook configured, each delivery wakes the loop at once, so a longer interval costs less latency. See [Rate limits](linear-integration.md#rate-limits).

### `completeOnMerge`

| | |
| --- | --- |
| Type | Boolean |
| Default | `true` |
| Panel | "Complete the Issue once its pull request merges" (advanced) |

Once the ticket's own pull request merged, move its Issue to the team's first completed state (lowest `position`), unless the Issue is completed or canceled already. A failed update is retried each round for up to 24 hours after its first failure, and counted in health as "pull request links or Issue completions failing". After that the Source gives up and logs it. An Issue Linear no longer has counts as done. Pull requests the ticket only follows do not count.

Chains complete the epic regardless of this setting, but never its sub-issues. A chain needs each sub-issue closed by this setting, by Linear's GitHub integration or by a person. A sub-issue whose ticket ends while it is still open stops the chain with "ENG-12 ended without being completed". Turning this off with chains in use means closing sub-issues another way.

### `chainParallel`

| | |
| --- | --- |
| Type | Integer, 1 to 8 |
| Default | `2` |
| Panel | "Sub-issues worked on at once" (advanced), across all epics |

The most sub-issues started at once, counted across all running chains. A sub-issue counts while it has an open ticket, a Trigger without a ticket yet, or an ended ticket whose Issue is still being completed.

## Policy

The Linear Source's Policy has one field.

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `allowed` | list of `{ id, name? }` | `[]` | Linear user ids who may originate work. `name` is a label, at most 100 characters. |

A listed person's session is an explicit request: they delegated an Issue to the agent or mentioned it in a comment. Every Linear Trigger is marked as addressing the agent.

Each enabled team has an admission row, labelled "Sessions only". Only the "not on the list, addresses the agent" cell applies. With dsh-superagent's default admission table, a session from someone not on the list is ignored. The "Received." thought still reaches them, as the Source cannot read the Policy.

Chain Triggers carry the person who delegated the epic as their actor.

The allowed list also gates chains. Only a listed person can start a chain (by delegating, re-delegating or writing `start`) or stop one. The Source asks dsh-superagent's `admits`, available from dsh-superagent `e16b265`. Without it, nobody can start or stop a chain, and health says so.

## Execution environment

The Source sets these variables for workers. They are empty when the ticket did not start on Linear, and when the value is not well-formed.

| Variable | Value |
| --- | --- |
| `DSH_SUPERAGENT_LINEAR_ISSUE` | The Issue identifier, such as `ENG-12`. Set only when it matches `^[A-Z0-9]+-\d+$`. |
| `DSH_SUPERAGENT_LINEAR_ISSUE_URL` | The Issue's page, not its agent session. Set only when it starts with `https://linear.app/`. |
| `DSH_SUPERAGENT_LINEAR_MODE` | `split` when the ticket plans an epic into sub-issues; empty otherwise. |

A pull request body with `Fixes ENG-12` lets Linear's own GitHub integration close the Issue as well.

## Trigger metadata

Triggers carry these `meta` fields. Undelegation and chain-stop Triggers carry only `team`, `teamKey`, `issue`, `identifier`, `issueUrl`, `session`, `kind`, `signal`, `repository`, and `history` or `chain`.

| Field | Present | Value |
| --- | --- | --- |
| `team`, `teamKey` | always | The Issue's team id and key. |
| `issue`, `identifier`, `issueUrl` | always | The Issue's id, identifier and page. |
| `session` | always | The agent session id. |
| `kind` | always | `session`, `prompt`, `chain`, `undelegated` or `chain-stop`. |
| `project`, `projectName` | when the Issue has a project | The project's id and name. |
| `delegate` | session and prompt, when the Issue has a delegate | The delegate's user id. |
| `labels` | when the Issue has labels | Label names. |
| `documents` | when the Issue's description links Linear documents | The linked documents' ids: the 12 hex characters that end a document link, in lower case, at most 20. |
| `repository` | when not the primary | The repository the ticket works in. |
| `parent` | when context was read and the Issue has a parent | The parent's id. |
| `children` | when context was read and the Issue has a parent or sub-issues | The number of sub-issues read. |
| `mode`, `epic` | split mode | `split` and the Issue's id. |
| `chain` | chain, chain-stop | The epic's id. |
| `activity` | prompt | The prompt activity id. |
| `signal` | stop prompt, undelegated, chain-stop | `stop`. |
| `history` | undelegated, when attributed | The history entry id. |
