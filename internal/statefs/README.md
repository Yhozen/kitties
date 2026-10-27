# Durable gateway files

Local installations keep ordinary filesystem behavior. A cloud gateway opens a dedicated disposable cache and hydrates an authoritative file manifest before loading its stores. A kernel lock prevents concurrent local writers; the remote service must fence older container epochs and serialize manifest commits.

Mutations upload immutable SHA-256 blobs and synchronously commit a revision before returning. Atomic renames publish the target bytes and remove the previous name in one commit. External SSH key generation uses `Publish` to commit the complete key pair before registration. Persistence failures terminate the process because existing stores can ignore returned write errors; an HTTP handler must never continue to a remote side effect with uncommitted state.

The private HTTP protocol is:

- `GET /v1/manifest`: `{revision, files: [{path, mode, parts: [{sha256, size}]}]}`.
- `PUT /v1/blob/{sha256}` and `GET /v1/blob/{sha256}`: raw immutable bytes. Hydration verifies size and digest.
- `POST /v1/commit`: `{id, baseRevision, mutations}`; a mutation uses `put`, `append`, or `delete`, with `path`, `mode`, optional `parts`, and optional `recursive`. The acknowledgement contains the new `revision`.

- `POST /v1/import/begin`: `{id, files, batches}` reserves an empty state service for one fenced writer and returns `{next}`.
- `POST /v1/import/batch`: `{id, index, mutations}` stages up to 256 put mutations, with a body below 2 MiB; `{next}` acknowledges the next batch index.
- `POST /v1/import/finalize`: `{id}` atomically publishes all declared files at revision 1 and returns `{revision: 1}`. Durable receipts deduplicate finalization after a lost acknowledgement.

Staged files remain invisible to manifest readers and exclude ordinary commits. A new writer epoch can replace an abandoned import. The client derives the import ID from its ordered mutations and resumes identical imports after a failed batch.

A commit ID deduplicates retries after a lost acknowledgement. The service must reject stale revisions, stale writers, path traversal, and missing blobs. Redirects are rejected. Cloudflare uses an intercepted private outbound binding rather than a public state-service credential.

Journal histories compact every 128 appends into 1 MiB chunks to bound cold-start reads. Temporary writes become durable only through their final rename; an artifact whose final name ends in `.tmp` is still retained. Lock and cache metadata are excluded from recovery captures.

`Snapshot` copies one committed revision under a write barrier. Callers must first drain background work and external effects. `Import` restores into an empty state service through bounded invisible batches and one atomic finalization, refusing existing state, links, or partial recovery. `Empty` is a read-only recovery preflight; it does not authorize overwriting populated state.
