# External event trigger sources

## First source: GitHub Actions

Use a local poller for completed workflow runs on explicitly selected public GitHub repositories. This keeps scheduling and event storage on the user's device and avoids requiring a webhook relay or hosted Tribe service. The first version is read-only and unauthenticated; private repositories require a later narrowly scoped credential integration.

The runtime requests GET /repos/{owner}/{repo}/actions/runs from the fixed api.github.com origin with status=completed and at most 100 results. Configuration accepts only an owner/repository pair or canonical https://github.com/owner/repository URL. The runtime must never accept an arbitrary API host, token, or URL from a schedule.

Polling must:

- Run only for an active schedule whose user selected GitHub Actions as its source.
- Require project approval for the api.github.com connection, separately from agent web grants.
- Group schedules by repository and fetch once per unique repository on each polling pass.
- Poll no more often than every 15 minutes per repository; persist backoff on provider errors and inspect response rate-limit headers before a production release.
- Track a per-schedule run ID cursor and ignore runs updated before the schedule was created. A first poll establishes the cursor without replaying repository history.
- Store only bounded run metadata needed to identify the workflow, branch, commit, conclusion, timestamp and source link. Do not fetch logs, artifacts, file contents, or commit messages.
- Mark provider metadata as untrusted context. The normal project role grants, approval mode, task ownership, deduplication, run budgets and failure review continue to govern each triggered run.

GitHub documents the workflow-runs endpoint as available without authentication for public repositories and caps per_page at 100. Unauthenticated requests are limited to 60 per hour per originating IP, so conditional polling must not be assumed to save quota without authentication. Tribe reserves at most 45 requests per rolling hour across all watched repositories in its local workspace, leaving headroom for other API use from the same network. This local budget cannot coordinate with other devices behind that network. See [List workflow runs](https://docs.github.com/en/rest/actions/workflow-runs) and [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

The schedule editor now accepts a public repository and requires an existing project web-access grant for `api.github.com`. Each schedule stores its own run-ID cursor and checks no more often than every 15 minutes. Provider failures use a persisted exponential backoff; rate-limit responses use `Retry-After` or GitHub's reset timestamp when available. A persistent rolling budget caps this workspace to 45 anonymous API requests per hour across all repositories and defers due polls visibly when the cap is reached. Tribe also persists GitHub's remaining-request and reset headers, so a zero remaining count pauses every repository until the documented reset. Anonymous requests are limited to 60 per hour per originating IP; the local cap leaves headroom but cannot account for other devices sharing that IP. Tribe records the newly observed failed workflow runs as a bounded batch in one normal project event; the existing event scheduler creates one durable investigation run in the selected destination chat. Pausing and resuming discards failures from the paused interval. Revoking web access stops delivery and displays an actionable status on the schedule. The poller shares one anonymous fetch across schedules monitoring the same repository, rechecks project access before recording, and never stores tokens.

The remote metadata is explicitly marked untrusted in the scheduled prompt. Role grants, run budgets, approval mode, task ownership and the normal failure-review path still apply. API errors do not enqueue agent work; the poller retries on its next interval. When several failures arrive between checks, Tribe records one event containing the bounded batch of newly observed run metadata and queues one investigation run, avoiding one agent run per failed workflow.

GitHub documents this endpoint as available without authentication for public repositories and caps `per_page` at 100. Anonymous requests are limited to 60 per hour per originating IP. At 15-minute polling, a machine monitoring more than 15 distinct repositories can exceed that shared quota; Tribe's 45-request workspace budget and header-based cooldown now constrain its own polling. Multiple devices sharing an IP still share GitHub's external quota. See [List workflow runs](https://docs.github.com/en/rest/actions/workflow-runs) and [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
