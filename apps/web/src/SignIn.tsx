import { useEffect, useState } from "preact/hooks";
import type { Account, LoginFlow } from "./api";
import { api, errText, openExternal } from "./api";
import type { SignIn } from "./friendly";
import { t } from "./i18n";

// SIGNING IN WITH A SUBSCRIPTION.
//
// A model can think on an account the person already pays for instead of an API key: a Claude
// plan (through the claude program), a ChatGPT plan, GitHub Copilot or a Google login. Each one
// signs in its own way; this panel walks through it and says when it is done.

const GCLOUD =
  "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/generative-language.retriever";

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="flex items-center gap-2 mt-1">
      <code class="command flex-1 min-w-0">{text}</code>
      <button
        type="button"
        class="btn-ghost px-2 py-1 text-xs flex-none"
        onClick={() =>
          navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => {})
        }
      >
        {copied ? t("Copied") : t("Copy")}
      </button>
    </div>
  );
}

function Link({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

export function AccountSignIn({
  signIn,
  account,
  onAccounts,
}: {
  signIn: SignIn;
  account?: Account;
  onAccounts: () => void;
}) {
  const [flow, setFlow] = useState<LoginFlow | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState("");
  const [project, setProject] = useState("");
  const pending = flow?.status === "pending";

  // Follow a sign-in that waits for the browser; a panel that closes cancels it.
  useEffect(() => {
    if (!flow || flow.status !== "pending") {
      return;
    }
    const id = flow.id;
    const timer = setInterval(() => {
      api
        .loginFlow(id)
        .then((f) => {
          setFlow(f);
          if (f.status === "connected") {
            onAccounts();
          } else if (f.status === "failed") {
            setErr(f.error || t("the sign-in failed"));
          }
        })
        .catch((e) => {
          setErr(errText(e));
          setFlow(null);
        });
    }, 1500);
    return () => clearInterval(timer);
  }, [flow?.id, flow?.status]);
  useEffect(
    () => () => {
      if (flow?.status === "pending") {
        api.cancelLogin(flow.id).catch(() => {});
      }
    },
    [flow?.id, flow?.status],
  );

  const start = async () => {
    setErr("");
    setBusy(true);
    try {
      const f = await api.startLogin(signIn.kind, project.trim() || undefined);
      setFlow(f);
      if (f.status === "connected") {
        onAccounts();
      } else if (f.url) {
        openExternal(f.url);
      }
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  };
  const paste = async () => {
    if (!flow) {
      return;
    }
    setErr("");
    try {
      setFlow(await api.pasteLogin(flow.id, pasted.trim()));
    } catch (e) {
      setErr(errText(e));
    }
  };
  const signOut = () => {
    setErr("");
    api
      .signOut(signIn.kind)
      .then(() => {
        setFlow(null);
        onAccounts();
      })
      .catch((e) => setErr(errText(e)));
  };

  if (signIn.unavailable) {
    return (
      <div class="callout callout-warn mt-3" data-testid="sign-in">
        {signIn.unavailable}
      </div>
    );
  }
  const error = err && (
    <p class="text-xs text-[var(--c-red)] mt-2" role="alert">
      {err}
    </p>
  );

  if (account?.signed_in) {
    return (
      <div class="callout callout-ok mt-3" data-testid="sign-in">
        {signIn.how === "cli" ? (
          <>
            <div>
              ✓ {t("Claude Code is on this computer")}
              {account.who && <span class="font-mono text-xs"> ({account.who})</span>}.
            </div>
            <p class="text-xs mt-1">
              {t("If it is not signed in yet, run this once in a terminal and follow the browser:")}
            </p>
            <Command text="claude auth login" />
          </>
        ) : (
          <div class="flex items-center gap-2 flex-wrap">
            <span class="flex-1">
              ✓ {account.who ? t("Signed in as {who}.", { who: account.who }) : t("Signed in.")}{" "}
              {t("Your {plan} pays for the answers.", { plan: signIn.label })}
            </span>
            <button type="button" class="btn-ghost px-2 py-1 text-xs" onClick={signOut}>
              {t("Sign out")}
            </button>
          </div>
        )}
        {error}
      </div>
    );
  }

  return (
    <div class="callout mt-3" data-testid="sign-in">
      <p class="text-xs text-[var(--t2)]">
        {signIn.help}
        {signIn.plans && (
          <span class="text-[var(--t4)]"> {t("Works with {plans}.", { plans: signIn.plans })}</span>
        )}
      </p>

      {signIn.how === "cli" && (
        <ol class="steps text-xs mt-2">
          <li>
            {t("Install Claude Code on this computer:")}{" "}
            <Link href={signIn.setupURL || "https://claude.com/product/claude-code"}>
              {t("how to install ↗")}
            </Link>
          </li>
          <li>
            {t("Sign it in once, in a terminal:")}
            <Command text="claude auth login" />
          </li>
          <li>
            <button
              type="button"
              class="btn-accent px-3 py-1.5 text-xs mt-1"
              disabled={busy}
              onClick={start}
            >
              {busy ? t("Looking…") : t("Done: find Claude Code")}
            </button>
          </li>
        </ol>
      )}

      {signIn.how === "gcloud" && (
        <>
          <ol class="steps text-xs mt-2">
            <li>
              {t("Install gcloud:")} <Link href={signIn.setupURL!}>Google Cloud CLI ↗</Link>
            </li>
            <li>
              {t("Sign it in once, in a terminal:")}
              <Command text={GCLOUD} />
            </li>
          </ol>
          <label class="block text-xs text-[var(--t3)] mb-1 mt-3" for="sign-in-project">
            {t("Google Cloud project ID")}
          </label>
          <input
            id="sign-in-project"
            class="w-full px-3 py-2 text-sm font-mono"
            value={project}
            onInput={(e) => setProject((e.target as HTMLInputElement).value)}
            placeholder={t("leave empty to use gcloud's quota project")}
          />
          <button
            type="button"
            class="btn-accent px-3 py-1.5 text-xs mt-2"
            disabled={busy}
            onClick={start}
          >
            {busy ? t("Checking…") : t("Use my Google login")}
          </button>
        </>
      )}

      {(signIn.how === "browser" || signIn.how === "device") && !pending && (
        <button
          type="button"
          class="btn-accent px-3 py-1.5 text-xs mt-2"
          disabled={busy}
          onClick={start}
          data-testid="sign-in-start"
        >
          {busy
            ? t("Opening…")
            : t("Sign in with {service}", {
                service: signIn.how === "device" ? "GitHub" : "ChatGPT",
              })}
        </button>
      )}

      {pending && flow?.method === "device" && (
        <div class="mt-2" data-testid="sign-in-code">
          <div class="text-xs">{t("Type this code on GitHub:")}</div>
          <Command text={flow.code || ""} />
          <p class="text-xs mt-1">
            <Link href={flow.url || "https://github.com/login/device"}>
              {t("Open github.com ↗")}
            </Link>{" "}
            · {t("waiting for you…")}
          </p>
        </div>
      )}

      {pending && flow?.method === "browser" && (
        <div class="mt-2" data-testid="sign-in-waiting">
          <p class="text-xs">
            {t("Finish signing in in your browser, then come back: this changes by itself.")}{" "}
            {flow.url && <Link href={flow.url}>{t("Open the page again ↗")}</Link>}
          </p>
          {flow.paste && (
            <>
              <p class="text-xs text-[var(--t4)] mt-2">
                {t(
                  "Did the browser end on a page that does not load (localhost:1455)? Copy its whole address and paste it here:",
                )}
              </p>
              <div class="flex gap-2 mt-1">
                <input
                  class="flex-1 min-w-0 px-3 py-2 text-xs font-mono"
                  value={pasted}
                  onInput={(e) => setPasted((e.target as HTMLInputElement).value)}
                  placeholder="http://localhost:1455/auth/callback?code=…"
                  aria-label={t("Address the browser landed on")}
                />
                <button
                  type="button"
                  class="btn-ghost px-3 py-1.5 text-xs"
                  disabled={!pasted.trim()}
                  onClick={paste}
                >
                  {t("Use it")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {error}
    </div>
  );
}
