# What Kitties should borrow from Cua Spaces

Research date: **27 October 2026**. Cua source inspected at [`c40ef077d1482e87bd3c570d08aed9fda465505c`](https://github.com/trycua/cua/tree/c40ef077d1482e87bd3c570d08aed9fda465505c); Kitties baseline inspected read-only at `235d26bea5609a3c36de0368579d015a71f6f58d`. The separate desktop-parity work in progress is outside this report's implementation scope.

## Recommendation

**Keep Kitties' gateway, Boat persistence and agent loop. Make its computer interaction feel immediate, then borrow Spaces' workspace presentation. Evaluate Cua Driver as an optional MIT guest-side tool backend. Do not fork the current Spaces app or streaming stack under the assumption that the repository is all MIT.**

Spaces exposes a broader workspace interface than current Kitties: computer inventory, whole-desktop and individual-window views, file and signed-in session transfer, and human/agent collaboration. This comparison is based on source and documentation, not a live usability benchmark. Its advantage is an integrated interaction system, not simply a different Linux wallpaper or a better model. But Kitties already solves a different, valuable problem: a small persistent personal fleet with chats, connectors, schedules, retained Boat recovery points, independently encrypted backups and a Cloudflare gateway that stays available without the laptop.

The highest-return sequence is: remove the repeated cold-path readiness work from warm interactions; establish a persistent, generation-fenced input session; measure input-to-visible-result latency; improve desktop presentation and handoff; then add semantic desktop capabilities. Replacing the entire runtime would put working recovery guarantees at risk before addressing the visible pain.

## Evidence and limits

- **Verified source** below means the pinned repository contains the described implementation, contract or test. This was source inspection, not a local build or a live Cua installation.
- **Documented/product** means current first-party documentation or pricing says the capability exists. Where code was also inspected, that is called out.
- **Recommendation/inference** means a proposed Kitties change or a conclusion drawn from those facts. Latency targets below are acceptance targets, not measured Kitties improvements.
- Cua changed substantially recently. Current public material is more reliable for this decision than older tutorials about `ComputerAgent`, Cua Cloud/Fleets or `cuabot`. Some current first-party pages also disagree on licensing; actual package licenses take precedence.
- No account was created, no software was installed into the user's environment, no VM was launched, no billable service was used, and no implementation or credentials were copied. The public source clone is in `/private/tmp/kitties-cua-source`.

## What Cua Spaces actually is now

A **computer** is a physical or rented Mac, Linux or Windows machine; a **Space** is a task desktop on one of those computers, implemented as a container, VM, microVM or the computer's own desktop. Spaces provides the application, sharing and connectivity. **Cua does not currently rent the computer to you.** Its hosted Cua Cloud/Fleets offering ended on **18 October 2026**; cloud placement now means your own account. This makes Spaces primarily a BYO-compute workspace product rather than a direct substitute for Boat. Sources: [Spaces architecture](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/spaces/concepts/how-spaces-works.mdx), [Cloud/Fleets migration notice](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/cua-sdk/guides/cua-cloud-ended.mdx).

Its layers are distinct:

| Layer | Actual role | Consequence for Kitties |
|---|---|---|
| Spaces apps | Shared React interface; macOS native shell, Electron/Tauri variants; computer/Space inventory, desktop windows, agents, Keyvault, Volume | Most visible polish lives here and is FSL, not MIT |
| `cua-spacesd` | In-machine service for processes, files, screenshot/input, accessibility, streaming, presence, teleport, ports | Useful architecture reference, but current daemon is FSL |
| Cua Driver | Cross-platform automation through native APIs, accessibility, browser tools, pixels, MCP/CLI/SDK | A separable MIT candidate for guest tooling |
| Cua SDK / CLI / daemon | Runtime-independent creation, placement, lifecycle, protocol clients, host setup and agent integrations | MIT orchestration is usable, but interfaces do not imply all Spaces implementations are included |
| Lume / QEMU / microVM runtimes | Machine execution and local snapshots | Broader OS/runtime support than Kitties; not a required replacement for Lima/Boat |
| Relay / mesh | Outbound connectivity, identity/sharing and optional encrypted peer transport | Useful for multi-device products; more machinery than Kitties' current owner-only gateway needs |

Sources: [SDK crate map and dependency architecture](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua/README.md), [spacesd service surfaces](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua-spacesd/README.md), [macOS app architecture](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/apps/cua-spaces-macos/README.md).

## Licensing: the central correction

**Current Cua Spaces is source-available under FSL-1.1-MIT. The root MIT license does not override nested licenses.** FSL permits internal use, modification and self-hosting for permitted purposes, but restricts competing commercial products/services; each version gains MIT permission on its second anniversary. The commercial licensing page explicitly includes hosted desktops, sandboxes and computer-use environments among services needing a commercial license. A private personal experiment and a distributed Kitties service have materially different implications. This report recommends keeping the latter option open by avoiding current FSL code imports. Sources: [actual Spaces license](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/apps/cua-spaces/LICENSE), [commercial terms](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/legal/COMMERCIAL.md).

| Scope at inspected commit | License / boundary |
|---|---|
| SDK, ordinary `cua` CLI/daemon, Driver, Lume, `cua-vmm`, `cua-byoc`, `cua-snapshot-sync`, `cua-mesh` | MIT, subject to dependency and artifact notices |
| Spaces apps and app core | FSL-1.1-MIT |
| `cua-spacesd` and `cua-relay` | FSL-1.1-MIT |
| Keyvault, teleport, machine sealing, Chromium session storage, `cua-volume`, Spaces extensions/FFI/CLI and cluster coordinator | FSL-1.1-MIT |
| `cua-media-protocol`, `cua-media-transport`, client, codecs, native/HTML5 viewers, streaming benchmark | FSL-1.1-MIT |
| General `cua-proto` gRPC contracts, SDK encoded-frame `MediaSession`, TypeScript `spaces/pip.ts` | MIT; these do not supply the complete FSL streaming implementation |
| Driver's optional perception extension | Not MIT: OmniParser detector artifact AGPL-3.0-only; OCR/model/runtime artifacts have separate terms |
| Older optional `cua-som` | AGPL-3.0-or-later; avoid accidental inclusion |
| CUA-S1 source | MIT; weights/datasets require their own artifact-specific check |
| Logos, product names, bundled application binaries, fonts, wallpapers, screenshots | Do not infer permission from root MIT; trademarks and third-party assets remain separate |

The repository's [detailed licensing map](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/legal/LICENSING.md) is explicit about these boundaries. It also explains that an MIT caller can expose an API whose actual implementation requires a Spaces extension and otherwise returns `host_capability_missing`. Merely depending on an MIT SDK does not acquire those implementations.

**A real documentation inconsistency:** the root README and streaming guide call the streaming wire contract open source/MIT, while `legal/LICENSING.md`, [`cua-media-protocol/LICENSE`](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua/crates/cua-media-protocol/LICENSE), [`cua-media-transport/LICENSE`](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua/crates/cua-media-transport/LICENSE) and their Cargo metadata mark those crates FSL. Use the actual licenses. The general protobuf API is still MIT; do not copy RCDP implementation code on the strength of the README sentence.

Public path-specific GitHub history shows the inspected Spaces/daemon/media license files arriving in [`9166817485ae53f3966935c13878a8196d79a399`, 1 October 2026, PR #4397](https://github.com/trycua/cua/commit/9166817485ae53f3966935c13878a8196d79a399). This establishes that those published paths were FSL at that point; it does **not** establish that every predecessor implementation was always FSL or that an equivalent older MIT Spaces implementation exists. Do not build a roadmap around a hypothetical old MIT fork without auditing the exact historical files and release artifacts. The present FSL release does not become MIT merely because the repository began as MIT.

For any MIT import, preserve Cua's copyright and MIT permission notice, retain relevant upstream/third-party notices, pin provenance and check the resolved dependency licenses. Preserve a small `THIRD_PARTY_NOTICES` entry recording source path and commit. Avoid Cua branding. For FSL evaluation, retain its terms and notices and settle the intended distribution model before it becomes a shipping dependency. These are implementation guardrails from the published terms, not definitive legal advice. Studying product behavior and implementing Kitties-owned code is the engineering recommendation for avoiding a dependency on current FSL implementations; this is not a legal determination that every possible implementation or distribution is unrestricted.

## Desktop and workspace UX: what feels superior

The application treats the computer as a primary working object. Verified UI source has live desktop tiles, visible machine location, progress and inline power errors, participant indicators, file drop targets, in-view video activation and retained thumbnails. Native macOS adds menu-bar/notch access and independent desktop windows; the shared web UI includes Spaces, Machines, Agents, Keyvault and Volume. Sources: [Space tile implementation](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/apps/cua-spaces-web/src/components/spaces/space-tile.tsx), [macOS surfaces](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/apps/cua-spaces-macos/README.md).

Kitties' current `LiveDesktop.tsx` already has a substantial canvas viewer, resize handling, sequential inputs, click/drag feedback, clipboard, expand/reduce, and rectangle → JPEG → screenshot fallback. Human takeover pauses the agent and times out after five idle minutes (`internal/orchestrator/control.go`). The missing product quality is therefore not “add a desktop viewer”; it is making the existing viewer immediate and organizing the workspace around it.

Borrow the following behavior with original Kitties implementation:

1. **Desktop-first overview:** each kitty has a last-known desktop image, explicit sleeping/stopped/restoring state, current task and an open action. Live previews are budgeted and run only when visible. A stopped thumbnail must not imply a live stream or wake the machine.
2. **Task + desktop together:** keep the current conversation beside the live computer; show which app/window a request refers to and preserve that context when the user says “this.” Cua's thread contract carries a `view` with desktop/window kind, app, title and window ID. [Thread contract](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/spaces/reference/threads.mdx).
3. **Clear control ownership:** visible “you control” / “kitty controls” state, immediate takeover/release, agent cursor or action target, and a short “waiting for you” affordance. Preserve exclusive human ownership initially; multiple visual cursors do not make concurrent mutations conflict-free.
4. **Independent watch window / PiP:** a small always-visible desktop while doing other work. The isolated MIT [`spaces/pip.ts`](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua/typescript/src/spaces/pip.ts) is a concrete reusable candidate: it wraps an already-painted canvas, supports Document PiP with video PiP fallback, and owns no media transport. Browser/webview support still needs checking in Kitties' shell.
5. **Drag-to-upload:** show destination, progress, cancel and completion; land files in a deliberate guest folder. This is substantially simpler than session teleport and immediately useful.
6. **Later, individual-window viewing:** list windows and optionally watch/control one app, reducing visual clutter and screenshot tokens. Requires robust window identity and geometry changes; a cropped screenshot alone is insufficient.

Do not confuse workspace UI with guest desktop design. Cua's default Linux image is **Ubuntu 24.04, XFCE on Xvfb, AT-SPI and PipeWire**, plus Chromium and toolchain tiers. Its shared starter script deliberately keeps X, session D-Bus and the desktop under one supervisor and exposes a fixed session bus to out-of-session tools. There is no reason to replace Kitties' original Lumen shelf/assets/fonts/wallpaper with Cua's XFCE styling. Borrow session supervision, accessibility environment and failure behavior as appropriate; keep Kitties' identity. Sources: [Linux image recipe](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/images/linux/Dockerfile), [desktop session startup](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/images/common/desktop/start-desktop.sh).

Omarchy is an optional Arch/Hyprland environment, not the prerequisite for Spaces. Driver documentation explicitly calls Hyprland/Omarchy experimental, with narrowly qualified isolated input and important Chromium/Electron, Unicode and modifier limits. Switching Kitties to it for appearance would add risk to a working X11 pipeline. [Platform support matrix](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/cua-driver/concepts/platform-support.mdx).

## Streaming and input: the first engineering priority

### What Cua implements

The control plane discovers a target, negotiates media and obtains a short-lived session ticket. Media stays outside gRPC: WebSocket through gateways/relay, optional pinned QUIC directly. Desktop video is H.264, Linux capture uses XShm/XDamage, native decoding uses VideoToolbox/OpenH264, browser decoding uses WebCodecs, and audio is an optional Opus track. The current docs say Linux uses software OpenH264; discovered NVENC/VA-API/QSV/AMF backends are not yet used. Sources: [media contract](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua/proto/MEDIA.md), [streaming guide](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/spaces/guides/stream-a-desktop.mdx).

The useful design details are more important than the codec:

- First frame on every attachment is independently decodable; geometry/codec changes have epochs.
- Each viewer keeps the latest useful frame rather than an unbounded backlog. Slow readers recover to current state.
- Input has ordered batches, sequence acknowledgments and explicit delivery errors. Persistent pointer/key state supports drags, key-up/down and text composition.
- Acknowledged native delivery and visible application outcome are distinct concepts.
- Healthy but unchanged screens are distinguished from broken capture; zero FPS can mean the desktop is idle.
- Input and resulting frames can be correlated, enabling actual input-to-photon measurement.
- Auth tickets are narrow in scope and lifetime; root-token rotation revokes attached sessions.

The pinned server source confirms WebSocket authentication at upgrade and bidirectional handling over the existing socket: [`media_ws.rs`](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua-spacesd/crates/cua-spacesd-desktop/src/grpc/media_ws.rs). Spaces delegates native injection to Driver, rather than duplicating OS input: [`driver_input.rs`](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua-spacesd/crates/cua-spacesd-desktop/src/driver_input.rs). These implementations are FSL; the separate Driver input contract is MIT.

### What to change in Kitties

The observed 7–8-second input is not evidence that Kitties first needs H.264 or QUIC. At the inspected baseline, `Acquire` calls `startComputer` for **every Boat acquisition**, even when status is already running (`internal/orchestrator/activity.go`). That start path checks remote state, invokes persistent runtime start/readiness, refreshes identity and applies theme; Boat `finishStart` calls `waitReady`. Human input flows through ordinary `Exec`/`ExecInput`. This is a visible repeated lifecycle cost, separate from image encoding.

Build a warm session abstraction keyed by logical kitty, remote ID, generation and gateway ownership epoch. Admit it only after normal readiness and ownership checks. Keep a lease while the viewer/control session is open. Revalidate at meaningful transitions, bounded intervals or errors; immediately invalidate on stop, restore, expiry, operation changes, revoked control, disconnect or lost ownership. Coalesce concurrent cold-start checks. **Never replace this with an unbounded boolean “ready” cache**: Kitties' identity/TTL/ownership safeguards are valuable.

Then send interactive events through an authenticated persistent session to a small guest input service or an SSH channel that stays open. Avoid one provider/readiness/SSH process sequence per keystroke. Keep agent tool execution on its deliberate, observable path; the human's fast input path can be lower-level while sharing lifecycle admission and control ownership. The MIT [`interactive_input.rs`](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua-driver/rust/crates/cua-driver-core/src/interactive_input.rs) is a good semantic reference: bounded batches, separate text commits, pointer phases, modifier state and delivery receipts. Its Rust/native backends may be run as a subprocess rather than rewritten wholesale in Go.

Add a Kitties-owned latency fixture before codec work: a guest square changes color on click, client timestamps event send, server records admission/dispatch, and the viewer detects the changed square. Record p50/p95, warm/cold, local/Boat, queue depth, first-frame delay and bytes/CPU. Initial targets: warm input acknowledgment p95 <250 ms and click-to-visible change p95 <500 ms on the actual owner path; report misses rather than claiming instant input. Cua's [benchmark budgets](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua/bench/streaming/budgets.json) contain a 300 ms median input-to-photon regression ceiling, but that is a configured budget on its fixtures, not a measured internet comparison and not code to copy under MIT.

Only then choose whether the existing rectangle stream needs an independently implemented standard encoded-video path. Measure idle, scrolling, video and five visible desktops. A codec change can reduce bandwidth while increasing software-encoder CPU. Keep fallback screenshots and transparent readiness/error states. A browser path through Cloudflare should start with WebSocket or the existing HTTP stream; native QUIC/mesh integration is a later project, not an assumed drop-in through the Worker.

## Lifecycle, storage, cloud placement and snapshots

Cua's local runtime breadth is real: containers prefer gVisor when available, QEMU provides Linux/Windows VMs, Lume provides Apple-silicon macOS VMs, and explicit microVM kinds use Firecracker or Apple virtualization runtimes. Hardware and image compatibility constrain placement. Its docs say AWS pool VMs/microVMs need offered bare-metal capacity for KVM, while the offered GCP/Hetzner machines run containers. This is not interchangeable with one private Boat VM per kitty. [Runtime/kind matrix](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/spaces/concepts/space-kinds.mdx).

The MIT QEMU runtime implements whole-machine memory snapshots, copy-on-write RAM/disk forks and guest identity rotation on restore. It waits for initial readiness/cloud-init before capturing a warm template. Named checkpoints can be pinned so normal deletion/pruning refuses them. The separate MIT snapshot-sync crate describes content-addressed manifests, SHA-256 verification, resumable range transfers, narrow read grants, fallback storage and a runtime ABI marker. Sources: [QEMU snapshot implementation](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua/crates/cua-vmm/src/qemu/snapshot.rs), [snapshot transfer implementation](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua/crates/cua-snapshot-sync/src/lib.rs).

These are useful for a future optional QEMU backend or cross-host same-runtime checkpoint transfer. They are not a way to memory-migrate Lima arm64 into Boat amd64, and snapshot transfer is not automatically an independently encrypted disaster backup. Keep architecture/runtime ABI checks and distinguish disk-only restoration from live-process continuation.

Cua Volume is a separate versioned shared drive: public reference material, agent-private homes, per-Space outputs, explicit grants, history and auditing. It survives deletion of a Space. Its server and storage implementation are FSL. Kitties already has shared artifacts/skills and persistent guest home files; a scoped shared filesystem could be a later expansion, not a replacement for R2 gateway state or restic. [Volume model](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/spaces/guides/cua-volume.mdx).

Kitties' `docs/CLOUD-PLAN.md` records concrete deleted-source Boat restore, installed-package/browser-cookie survival, immutable snapshot-bundle export, five-machine isolation, new gateway generation recovery and independent backup verification. Cua's generic durability labels should not erase those distinctions. In particular, its own durable-agent docs say a relocated Space may be empty; workspace-only snapshots omit installed packages and other directories, and machine checkpoints can remain local to the original daemon. [Durable-agent guarantees and limits](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/cua-sdk/guides/durable-agent-guarantees.mdx).

For a future second cloud provider, borrow MIT BYOC **policies and invariants**: provider-visible owner tags, persisted create records, grace periods, inventory scope, dry-run cleanup, TTLs, budget/size caps, audit and orphan sweeps. [`sweep.rs`](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua/crates/cua-byoc/src/sweep.rs) explicitly distinguishes “not listed in this region” from “gone.” Keep Boat's separate restore receipt exception for missing labels; do not replace verified Kitties-specific behavior with a generic tag rule.

## Agent/vision loop and tool quality

The current direction is **bring your own agent and model**. Legacy Python `cua-agent`/`ComputerAgent` is deprecated. Spaces can launch coding-agent harnesses over ACP and maintain named agents, tasks, memory and notifications; that does not mean it contains a universally superior vision reasoning loop. [Migration notice](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/cua-sdk/guides/cua-cloud-ended.mdx), [agents in a Space](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/spaces/guides/agents-in-a-space.mdx).

Keep Kitties' working `gpt-6-luna` Responses image/function-call continuation, native tool catalog, connectors and personality. It already combines pixel tools with OCR and browser CDP tools (`page_read`, `page_click`, `page_type`), so semantic operation is an extension rather than a new concept. The direct opportunity is **native accessibility and stronger observation identity**, not another provider switch.

Driver offers native window identity, accessibility trees, browser routes and structured refusals, with pixel fallback. Linux X11 is supported with toolkit limits; Linux Chromium trusted background pointer delivery is explicitly unavailable, and raw background gestures have platform restrictions. An optional Driver backend should return these refusals and use the existing foreground desktop in a private VM rather than silently claiming background support. [Driver platform matrix](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/cua-driver/concepts/platform-support.mdx).

Borrow/adapt the idea that every observation carries its target, geometry, capture identity and generation, and that element references or pixel actions fail when their observation is stale. Do not oversell the current source: [`capture_registry.rs`](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua-driver/rust/crates/cua-driver-core/src/capture_registry.rs) labels itself a foundation that does not alone authorize production actions; perception wiring and authorization are separate. Evaluate the full operating route rather than copying a registry and claiming the safety property is complete.

Cua also journals tool intent before permission responses and fences resumed runs by epoch. Its own contract distinguishes guarded calls from unguarded calls and explicitly rejects an exactly-once claim for external effects. Kitties should eventually add durable per-action intent/result IDs and recovery notes, preserving today's rule against automatic replay of potentially completed external effects. Sources: [MIT durable runner contract](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua/crates/cua-agents/src/durable.rs), [recovery semantics](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/spaces/guides/keep-an-agent-running.mdx). Shipping/mirroring journals through Cua Volume still needs the FSL implementation; the MIT runner contract is not the whole system.

The optional AGPL perception extension and early CUA-S1 form-decision models are poor first investments here. Kitties already has vision. First improve tool determinism, accessibility and end-to-end latency; compare task success and token cost before adding another model/artifact lifecycle.

## Authentication, isolation and session transfer

Spaces' guest daemon requires a token for non-loopback binding, supports token rotation, uses expiring scoped media/file/tunnel tickets and can revoke active sessions. This is useful design guidance; Kitties already has owner authentication through Cloudflare Access, a gateway-only bearer, private Boat API/SSH keys and pinned SSH host keys. Keep credentials off the browser and guest. Adding a guest service does not require publicly exposing it. [Daemon authentication](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua-spacesd/README.md).

The mesh node is MIT and uses userspace WireGuard via BSD-licensed boringtun. Its production coordinator, relay authorization and sharing logic are FSL. Current documentation distinguishes encrypted mesh connections from a fallback HTTPS relay path that can read shell/files/input/media in transit. `CUA_MESH=require` refuses that fallback; `prefer` allows it. Device enrollment/sharing/revocation are additional security systems, not a checkbox delivered by importing the mesh crate. [Relay security and explicit limitations](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/spaces/guides/relay-security.mdx), [MIT mesh dependencies](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua/crates/cua-mesh/Cargo.toml).

**Teleport is a valuable product idea but a late feature.** It installs supported apps and moves selected files/session state after a consent preview; browser session cookies require separate opt-in, keychain access and decryption/re-encryption across machines. Chrome saved-password transfer has a documented limitation; it is not a general app/process-memory migration. Kitties should first do file handoff, then optionally selected-domain browser sessions with explicit scope, encrypted delivery and destination identity checks. Do not blindly copy an entire browser profile, transport a host Safe Storage key, or expose session secrets to model context. Current implementation and Keyvault/sealing are FSL. [Teleport behavior and limitations](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/spaces/guides/teleport-an-app.mdx).

For isolation, distinguish Docker shared-kernel, gVisor and real VM properties; neither a themed desktop nor an agent tool permission mode changes the underlying boundary. Preserve the VM user's least privilege and browser sandbox where supported. Multi-user sharing would require a proper view/control authorization model and revocation for open streams; the owner-only deployment does not need that expansion yet.

## Costs and operational implications

As checked on 27 October 2026, the public [Spaces pricing page](https://cua.ai/pricing) lists Free at two live relay sessions/20 remote hours monthly, Pro at $18 monthly or $180 annually with five sessions/200 hours, and Teams at $30 per seat monthly or $300 annually, from one seat, pooling five sessions/200 hours per seat. Compute is billed separately by the provider. Expiring share links/90-day history and SSO/audit export are marked future features; do not count them as shipped entitlements. Pricing is a point-in-time observation, not a cost guarantee.

For Kitties, product cost is approximately: Boat running time + retained checkpoints/export + Worker/Container/DO/R2 + independent backup storage/transfer + model tokens. Cua's app subscription is not an alternative all-in VM bill. Its own-cloud path introduces provider IAM/network/bootstrap, inventory reconciliation, image maintenance and cleanup. Bare-metal virtualization can be a large fixed expense for only one to five desktops. [Own-cloud resource and cleanup guide](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/docs/content/docs/cua-sdk/guides/your-cloud.mdx).

The most relevant incremental costs are predictable: preview streams multiply bandwidth and software encode CPU; permanent guest services add a release/update surface; stored action/screenshot history increases sensitive data and R2 volume; multi-device relay/mesh adds operational infrastructure. Benchmark before turning on five continuous previews. Keep the current distinction between real work/viewer leases and passive dashboard thumbnails so UI polish does not defeat idle sleep. No defensible monthly cost comparison is possible without the owner's actual workload and provider bills.

## Reuse decisions

| Candidate | Decision | Why / integration shape |
|---|---|---|
| TypeScript `spaces/pip.ts` | **Direct reuse candidate, MIT** | Small, browser-only, canvas-based; vendor with provenance and test in Kitties webview |
| Driver binary/MCP/CLI, X11 and AT-SPI tools | **Optional adapter experiment, MIT** | Gain semantics and window handling without a Rust port; pin artifact/version and run only inside guest |
| Driver input event contract/backends | **Adapt or use through binary, MIT** | Right model for low-latency human input; Go/UI contract still belongs to Kitties |
| Shared desktop startup/accessibility setup | **Adapt selected MIT scripts** | Session D-Bus consistency and all-or-restart supervision; retain Lumen and Kitties paths |
| `cua-byoc` sweep/budget/tag logic | **Adapt invariants; future provider reference, MIT** | Strong ownership/expiry policy; do not introduce a Rust SDK for Boat solely to reuse a helper |
| QEMU/Lume and snapshot sync | **Defer as optional runtime, MIT** | Useful breadth and warm forks; larger operational change, no immediate fix for viewer/input |
| Agent onboarding/config preservation | **Adapt when external-agent integration is requested, MIT** | Atomic, backup-aware structural config edits and uninstall ownership are better than string replacement |
| General protobuf/capability/error patterns | **Adapt selectively, MIT** | Versioned capabilities and structured failure; wholesale gRPC migration is unnecessary now |
| Spaces web/native UI and live-video components | **Study behavior; implement original UI** | FSL, closely coupled to app core and media bridges |
| spacesd, RCDP media implementation/transport/viewers | **Do not ship as MIT** | FSL boundaries; substantial integration and dependency surface |
| Keyvault, teleport, Volume, cluster coordinator | **Defer or obtain appropriate license** | FSL, high security/operational complexity, weaker immediate return |
| Legacy `cuabot`, `cua-agent`, `cua-computer-server` | **Skip** | Deprecated; `cuabot` explicitly has known security issues |
| Optional AGPL perception/OmniParser bundles | **Skip for initial work** | Separate artifact licensing and delivery obligations; existing vision already works |
| Cua branding, wallpapers, screenshots, third-party binaries | **Do not copy indiscriminately** | Trademarks and individual asset/application terms; use original Kitties assets |

Agent setup evidence: [`cua-agent-setup/README.md`](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/libs/cua/crates/cua-agent-setup/README.md). Licensing evidence for all decisions: [pinned licensing map](https://github.com/trycua/cua/blob/c40ef077d1482e87bd3c570d08aed9fda465505c/legal/LICENSING.md), actual nested licenses and package metadata.

## Prioritized follow-up PRs for Kitties

These are proposed, reviewable increments. Dependencies are explicit; no implementation is part of this report.

| Priority / PR | Scope | Acceptance evidence |
|---|---|---|
| **P0: warm interaction session** | Separate readiness/lifecycle from admitted warm operations; generation/ownership/TTL-bound lease; coalesce cold checks; invalidate on lifecycle changes | Actual warm Boat input timing; stop/restore/expiry/revocation during a session fails closed; cold recovery still follows known checkpoint and ownership rules |
| **P0: persistent input transport** | One authenticated guest channel per control session; bounded sequenced key/pointer/text events, acknowledgments and cancellation; release pressed inputs on disconnect | Click, drag, modifiers, IME/text and disconnect work; p50/p95 click-to-photon reported; typing does not make one provider readiness round-trip per key |
| **P1: complete Lumen guest parity** | Finish the already-authorized shared shelf, wallpaper, fonts, icons and defaults; migration preserves home preferences | Fresh Lima/Boat and restored home screenshots; browser profile and installed tools survive; no visual difference caused by runtime packaging |
| **P1: desktop workspace UI** | Last-known/live cards, current task, meaningful lifecycle/progress, side-by-side task+desktop, explicit handoff, PiP, drag upload | Stopped thumbnails never wake machines; offscreen video stops; takeover pauses agent; upload progress/cancel; PiP works in supported browser/shell |
| **P1: stream freshness and health** | Own latest-frame queue, geometry/generation epochs, first independent frame, recoverable reconnect, distinguish idle from broken | Slow-reader/stall/reconnect/resize tests and real Cloudflare path; time to first frame and bandwidth/CPU for one/five desktops; old-generation frames never paint |
| **P2: optional Cua Driver backend** | Pinned MIT Driver inside guest; add native accessibility/window-state tools behind adapter; keep current CDP and pixel path | Representative Chromium/LibreOffice/file-manager tasks; structured unsupported results; no host access; compare success, time and image tokens against baseline |
| **P2: durable action journal** | Intent/result IDs and generation/epoch per effect; interrupted outcome recovery note; explicit safe-retry classification | Kill after dispatch/before result; state remains reviewable; no automatic replay of a payment/send/push; stale worker cannot commit current results |
| **P3: scoped browser session handoff** | First selected-domain cookies if needed; approval preview, destination pinning, encrypted delivery, audit and cleanup | No host key/profile copied wholesale; unapproved domains/secrets excluded; restored browser state usable; credentials absent from prompts/logs |
| **P3: provider/runtime breadth** | Evaluate optional QEMU/Lume or another cloud only after measured need; preserve provider-specific persistence capabilities | Same identity/recovery contract, installed packages/profile survival and cost/cleanup proof; no silent cross-architecture or runtime substitution |

Do **not** make provider migration, shared team accounts, audio, multiplayer mutation, custom mesh, full Keyvault, or a new vision model prerequisites for the P0/P1 work. The user-visible improvement can be large while retaining the current system.

## Decision to make after the first measurements

If fast warm input plus Lumen/workspace polish meets the owner workflow, continue with the small Kitties stack and selectively integrate MIT Driver capabilities. If robust multi-device sharing, cross-OS windows and sophisticated session teleport become the main goal, evaluate using the complete Spaces product for personal/internal use, or licensing its FSL implementation for the intended service model. That is a product/dependency decision with clear benefits; it should not emerge accidentally from copying a root-MIT repository.

The immediate recommendation remains **improve Kitties in place, borrowing interaction contracts and selected MIT modules**. Spaces is an excellent reference for what the desktop should feel like. It is not evidence that Kitties should discard its verified persistence and recovery work.
