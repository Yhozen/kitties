import http from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const stages = { next: "https://next.kitties.rccpr.tech", prod: "https://kitties.rccpr.tech" };

const headers = {
  "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff",
};

export function parseCallback(url) {
  for (const key of ["state", "code", "client_id", "iss", "error"])
    if (url.searchParams.getAll(key).length > 1) throw Error("Invalid authorization response.");
  const state = url.searchParams.get("state");

  if (!/^[a-zA-Z0-9_-]{43}$/.test(state ?? "") ||
      (!url.searchParams.get("code") && !url.searchParams.get("error")))
    throw Error("Invalid authorization response.");

  return Object.fromEntries(Object.entries({
    state, code: url.searchParams.get("code"), clientId: url.searchParams.get("client_id"),
    issuer: url.searchParams.get("iss"), error: url.searchParams.get("error"),
  }).filter(([, value]) => value !== null));
}

// The helper never exchanges a code or receives access, refresh or ID tokens.
export async function startHelper({ stage, fetcher = fetch, timeoutMs = 600000 }) {
  const origin = stages[stage];

  if (!origin) throw Error("Usage: pnpm chatgpt:connect --stage next|prod [--no-open]");
  let busy = false, port, timer, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });

  const finish = result => {
    clearTimeout(timer); server.close(); server.closeIdleConnections(); resolveDone(result);
  };

  const server = http.createServer(async (request, response) => {
    const host = `127.0.0.1:${port}`;

    if (request.headers.host !== host || request.method !== "GET" || !request.url || request.url.length > 16384) {
      response.writeHead(400, headers).end("Invalid callback.");

 return;
    }

    const callback = new URL(request.url, `http://${host}`);

    if (callback.origin !== `http://${host}` || callback.pathname !== "/auth/callback") {
      response.writeHead(404, headers).end("Not found.");

 return;
    }

    if (busy) { response.writeHead(409, headers).end("This callback is already being handled.");

 return; }

    let payload;

    try { payload = parseCallback(callback); }
    catch { response.writeHead(400, headers).end("Invalid callback.");

 return; }

    busy = true;

    try {
      const remote = await fetcher(`https://auth-${stage}.kitties.rccpr.tech/oauth/chatgpt/callback`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });

      const result = await remote.json();

      if (!remote.ok || result.status !== "connected" || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.accountId ?? ""))
        throw Error("Authorization was not completed.");
      const destination = new URL("/?panel=settings", origin);
      destination.searchParams.set("chatgptProbe", result.accountId);
      response.writeHead(303, { ...headers, Location: destination.href }).end();
      finish({ ok: true });
    } catch {
      response.writeHead(400, headers).end("Authorization was not completed. Return to Kitties for the attempt status, then run the helper again.");
      finish({ ok: false });
    }
  });

  server.headersTimeout = 10000; server.requestTimeout = 10000; server.maxHeadersCount = 30;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const browserUrl = new URL("/?panel=settings", origin);
  browserUrl.searchParams.set("chatgptCallback", redirectUri);
  timer = setTimeout(() => finish({ ok: false, expired: true }), timeoutMs);

  return { redirectUri, browserUrl: browserUrl.href, done, close: () => finish({ ok: false }) };
}

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== "--");
  const index = args.indexOf("--stage"), stage = args[index + 1];

  if (index < 0 || !stages[stage] || args.some((arg, i) => i !== index && i !== index + 1 && arg !== "--no-open"))
    throw Error("Usage: pnpm chatgpt:connect --stage next|prod [--no-open]");
  const helper = await startHelper({ stage });
  process.once("SIGINT", helper.close); process.once("SIGTERM", helper.close);
  console.log(`Linking ChatGPT to Kitties (${stage}). Sign in as the Kitties owner, then choose Continue with ChatGPT.`);
  console.log(helper.browserUrl);

  if (!args.includes("--no-open")) {
    const program = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
    const child = spawn(program, process.platform === "win32" ? ["url.dll,FileProtocolHandler", helper.browserUrl] : [helper.browserUrl], { stdio: "ignore" });
    child.on("error", () => console.log("Open the Kitties URL above in your browser on this computer."));
    child.unref();
  }

  const result = await helper.done;
  console.log(result.ok ? "Linked. Kitties will verify model access with a minimal streamed request. Usage remains gated until acceptance passes." : result.expired ? "Linking expired. Run the command again." : "Linking did not complete. Check the attempt in Kitties and run the command again.");
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error("Could not start linking. Use: pnpm chatgpt:connect --stage next|prod [--no-open]"); process.exitCode = 1; });
