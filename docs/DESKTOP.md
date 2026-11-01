# A kitty's desktop

Each active kitty has a persistent Boat VM. The `kittyd` daemon connects outbound to Cloudflare
over a scoped WebSocket. The PWA can watch live frames, take control, send input and use the
clipboard. The model uses DOM/accessibility references when possible and screenshots otherwise.

Start, sleep, restore and upgrade are durable operations visible in the desktop panel. Sleep
quiesces the guest before checkpointing; a quiesce failure parks for repair. Restore creates a new
generation from the checkpoint and reconnects with fresh credentials. Capacity is limited to five
active desktops. First installation may take many minutes; retries reuse installed steps.

Tool intents and receipts prevent duplicate effects across disconnects or redeployments. An
unknown outcome needs an owner decision. A vault reference can type a secret without putting the
plaintext into the model context. Never resend an unknown action without checking its outcome.

Measured 200-input latency: ack p95 242.6 ms; click-to-visible p95 359.6 ms. Non-model agent step
overhead remains above its 1 s target; see [latency](effect/LATENCY-BASELINE.md).
