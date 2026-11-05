// Small native control for separating workerd disconnect delivery from Effect ownership.
let aborted = 0;
let cancelled = 0;
let written = 0;
let release;
const waiters = new Set();
const snapshot = () => ({ aborted, cancelled, written });

const notify = () => {
  for (const waiter of waiters) waiter();
  waiters.clear();
};

export default {
  async fetch(request, _env, context) {
    const path = new URL(request.url).pathname;

    if (path === "/stats") return Response.json(snapshot());

    if (path === "/release") {
      release?.();

      return Response.json(snapshot());
    }

    if (path === "/wait") {
      if (aborted === 0 && cancelled === 0)
        await new Promise((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            waiters.delete(finish);
            resolve();
          };

          const timer = setTimeout(finish, 4000);
          waiters.add(finish);
        });

      return Response.json(snapshot());
    }

    if (path !== "/watch") return new Response(null, { status: 404 });
    let timer;
    let finished = false;
    const done = Promise.withResolvers();
    const extra = Promise.withResolvers();

    const finish = () => {
      finished = true;
      clearTimeout(timer);
      done.resolve();
      extra.resolve();
    };

    release = () => extra.resolve();
    context.waitUntil(done.promise);
    request.signal.addEventListener(
      "abort",
      () => {
        finish();
        aborted++;
        notify();
      },
      { once: true },
    );

    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("initial\n"));
          context.waitUntil(
            extra.promise.then(() => {
              if (finished) return;
              controller.enqueue(new TextEncoder().encode("released\n"));
              written++;
            }),
          );
          timer = setTimeout(() => {
            controller.close();
            finish();
          }, 20000);
        },
        cancel() {
          finish();
          cancelled++;
          notify();
        },
      }),
    );
  },
};
