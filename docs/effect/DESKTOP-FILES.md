# Desktop file sharing

Open a computer's **Files** panel. Upload or drop one file (up to 64 MiB), then open
`/home/kitty/work/Shared` in its desktop. Save a document there to download it in the panel.
Subfolders can be browsed. Hidden names and symbolic links are excluded. Uploads receive a
unique filename and never deliberately replace an existing document. Refresh after a failed
or cancelled upload before retrying: a disconnected request may already have completed.

Library remains shared storage in R2. It now streams uploads up to 64 MiB and downloads with
the original filename, including Unicode. **Send a Library file to this desktop** copies an
existing Library file into the currently selected Shared folder without a browser roundtrip.
The kitty's desktop instructions point to Shared for inputs and deliverables.

## Transport and permissions

[cmux](https://cmux.com/docs/ssh) sends dragged files using SCP over its existing SSH
ControlMaster. Its management lane remains SSH even with Mosh. Kitties follows the separation
of file data from interactive media, using Boat's existing authenticated file service instead
of introducing browser SSH credentials or a new upload daemon.

[Boat upload URLs](https://docs.boat.dev/api/reference/agent/create-upload-url) and
[download URLs](https://docs.boat.dev/api/reference/agent/create-download-url) accept raw bytes,
including files larger than the JSON file endpoint's 5 MiB limit. The gateway obtains a
60-second URL and streams through it. The owner browser sees only same-origin Kitties URLs;
Boat credentials and signed URLs never reach it. Outbound URLs must be HTTPS on `*.on.boat.dev`,
with no credentials, port or fragment, an exact canonical path and the expected method.
Redirects are refused. Files are downloaded as attachments with `nosniff`, never inline HTML.

Boat only serves canonical paths under `/home/user` or `/tmp`. Provisioning creates
`/home/user/.kitties/shared`, links it as `/home/kitty/work/Shared`, and gives `kitty` and
Boat's `user` account access through named/default ACLs. Parent directory permission grants
only traversal; browser profiles and the rest of `/home/kitty/work` are not exposed. Setup
refuses unexpected symlinks or a pre-existing unrelated `Shared` directory; it does not move
or erase that directory. Existing computers need the new guest release and an **Upgrade**.
Lima guests without Boat's `user` account skip the Boat-specific setup.

The gateway verifies the kitty record and exact sandbox ownership before signing. Every
transfer obtains a persisted KittyDO lease for one remote ID and generation. Four may run
concurrently; every lifecycle operation refuses active leases, and idle sleep counts them as
activity. Requests have a five-minute deadline, with a six-minute lease to cover interrupted
cleanup. Successful requests release early; uncertain uploads keep their lease until expiry
and are never replayed. Recovery or a provider-side shutdown can still interrupt a transfer.
Downloads and normal lifecycle requests cannot retarget an in-flight transfer to a restored
sandbox. A stale UI generation is rejected before signing.

The streams apply backpressure, count bytes, enforce the 64 MiB cap, and check declared
lengths. Downloads buffer at most 64 MiB in the browser to support progress, cancellation,
error messages and a named file save across browsers. This intentionally limits browser
memory and stays below Cloudflare's normal request-body ceiling. There is no resumable
multipart upload or automatic retry in this slice.

## Validation

- `pnpm check`, `pnpm test`, `pnpm build`.
- `node guest/kittyd/tests/files-browser.mjs`: actual Preact component and Chrome; mocked HTTP
  service; 6 MiB binary upload/download, file drop, Library send, stale-view error, cancellation,
  no replay and mobile width. CI runs this test.
- `desktop-files-live.json`: local workerd, real HomeDO/KittyDO, and an isolated private Boat
  sandbox with no account environment or snapshots. A temporary **local-only** operator hook
  bound the fixture to the actor; it was removed after acceptance. Checks include binary and
  Unicode roundtrip, Library → R2 → desktop, authorization/path/generation/size rejection and
  sleep/upgrade blocking during a throttled upload. Real Chrome also uploaded a text file and
  downloaded a file created by the desktop account through this same gateway.
- The Boat fixture verified `kitty` can read uploaded bytes, create downloadable files, and
  cannot list the private parent. Both temporary fixture sandboxes were deleted by exact ID
  after confirming their probe labels. No user sandbox was modified.

Evidence is scoped to this cloud development VM and its isolated Boat fixture. This is not
an owner-Mac or deployed `next` acceptance result. Production and `next` were not deployed.
