# Shared Library leaf

`index.ts` exports Schema `Flags`/`Model`, `init`, `Message`, pure `update`/`view`,
`subscriptions`, `LibraryServices`, and the host authentication service. The
runtime supplies `LibraryApi.Client` and `LibraryClientAuthentication`; the leaf
uses the official beta.85 Domain Foldkit adapter. It does not bootstrap a runtime
or persist drafts/pending operations.

Flags contain `{ scope: { owner, epoch, sessionId }, language }`. Epoch is a safe
nonnegative integer; session IDs have 1–80 ASCII letters/digits/underscore/dot/
hyphen. They contain no credentials. New IDs are
`library:<epoch>:<CommandIds.next result>`; Unknown retries retain both the full
ID and original input. Success uses the receipt source barrier for detail and
waits for confirmed catalogue state. There is no optimistic acceptance.

The named `reauthenticate(scope)` capability returns void only after fresh,
same-owner/epoch client credentials and scoped watches are available. Its typed
failure distinguishes ChangedAuthority, Denied and Unavailable. ChangedAuthority
fences this screen; the host must remount/fence safely rather than adopt an old
intent into a new epoch. Void success retains the old session/counter. Terminated
watches disable; successful reauthentication/reconnect creates a new generation.
The host transport translates explicit authentication denial into the declared
`LibraryUnauthorized`. A late network failure remains Unknown even after local
expiry; time alone cannot establish that a sent command was refused. The leaf
never fabricates refresh or stores tokens.

## Evidence

On Node 26.13.0 with repository policy unchanged:

```sh
node_modules/.bin/vp fmt apps/web/src/foldkit/library --check
node_modules/.bin/vp lint apps/web/src/foldkit/library
node_modules/.bin/vp test --project web apps/web/src/foldkit/library
node_modules/.bin/tsc --noEmit
```

Story, rendered Scene, actual in-process Domain/client seams and boundary/race
tests exercise proposal/review/accept/remove,
en/es/pt, frozen retries, typed failures, watch lifecycle/key/generation guards,
source barriers, no optimistic confirmation, draft preservation, auth races and
counter/input limits. Scene tests use accessible roles/labels. Effect tests use
Layers and unaliased `it`; no module mocks, live providers or sleeps.

Four temporary implementation mutants each failed its targeted test (exit 1):

| Mutant | Independent failure |
| --- | --- |
| Retry replaces retained ID with a new suffix | Story expected original `library:7:fixture:0`, received `...:retry` |
| Detail drops actual API `atLeast` | In-process client observation expected receipt Some, received None |
| Reauth leaves catalogue generation unchanged | Expected enabled generation 1, received generation 0 |
| Late receipt bypasses ChangedAuthority fence | Expected unchanged fenced model/draft; receipt mutated it |

Only these new leaf modules were mutated. `finally` restored exact SHA256 bytes:
`update.submission.ts` a61df9fc560de917cc7c16616aec290a361dedf969ebfd92c36d8a68b6bf5281;
`command.ts` ffbfc0cef7fc41f82283b268d0028d9dd6c5a29669eb4a8b02c429bf05a62ff9;
`update.session.ts` d8715c26b5e0c92ba7ff52812af15f2806f8f91fd14ebf67dc25634ce0fa8c27.
Filtered mutant runs select cases at the CLI; sources contain no focused/skipped
tests. Full suite reruns after restoration.

Reviewing an existing catalogue entry uses its own `detailRevision` with the
official Library source stream. A real in-process delayed-delivery test proves
the read waits for that detail revision, even when another skill has advanced
the catalogue further. Stale detail errors render an alert even when the last
value was null. Four additional audit mutants cover the missing barrier, an
incorrect aggregate-wide revision, the hidden null-detail error and replacement
of a pending receipt barrier during reauthentication; all are rejected and
restored byte-for-byte.

## Integration gates

The in-process authority is explicitly a local fixture. Actual host client
replacement, expired HTTP/provider classification, cancellation/disposal,
browser entry/navigation/CSS, managed Access/OAuth and packaged IPC/runtime are
host integration work. This leaf alone does not prove them. Root owns composition
and the existing Preact migration; business rules remain in Domain.
