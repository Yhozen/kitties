interface Channel {
  viewers: number;
  grant?: unknown;
  pending?: number;
  fileTransfers?: number;
}

// Closing a socket and releasing a grant are asynchronous at the actor. Wait for
// its view of the channel; never resend desktop input while waiting for receipts.
export async function waitForDesktopIdle(
  read: () => Promise<{ channel: Channel }>,
  signal: AbortSignal,
) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 250);
      signal.addEventListener("abort", abort, { once: true });
    });
    signal.throwIfAborted();
    const { channel } = await read();
    signal.throwIfAborted();
    if (!channel.viewers && !channel.grant && !channel.pending && !channel.fileTransfers) return;
  }
  throw new Error("DESKTOP_STILL_IN_USE");
}
