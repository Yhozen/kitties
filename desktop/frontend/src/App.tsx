import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Kitty, ProviderInfo, Session } from "./api";
import { ApiError, api, cookieLogin, errText, inWails, watchChat } from "./api";
import { ConfirmHost, ask } from "./Confirm";
import Login from "./Login";
import Welcome from "./Welcome";
import Composer from "./Composer";
import Conversation from "./Conversation";
import { IconMenu, IconMonitor, IconTrash, IconUsers } from "./icons";
import LiveDesktop from "./LiveDesktop";
import { ConnectModal, KittyDrawer, NewChatModal, NewKittyModal } from "./Modals";
import SettingsModal from "./Settings";
import LibraryModal from "./Library";
import ApprovalsModal from "./Approvals";
import Sidebar, { moodOf } from "./Sidebar";
import PixelCat from "./PixelCat";
import { cycleMode } from "./theme";
import { t } from "./i18n";

type ModalKind =
  | "none"
  | "chat"
  | "kitty"
  | "connect"
  | "login"
  | "settings"
  | "connectors"
  | "connectors-add"
  | "models-add"
  | "library"
  | "artifacts"
  | "connector"
  | "approvals"
  | "notifications"
  | "preferences";

// The route is the hash: #chat/<id> or #kitty/<id>, so a view can be linked and reloaded.
function routeFromHash(): {
  chat: string | null;
  kitty: string | null;
  modal: ModalKind;
  connector: string;
} {
  const m = location.hash.match(
    /^#(chat|kitty)\/([a-z0-9-]+)(?:\/new-(chat|kitty|connectors-add|connectors|models-add|connect|settings|library|artifacts|approvals|notifications|preferences))?/,
  );
  const n = location.hash.match(
    /^#new-(chat|kitty|connectors-add|connectors|models-add|connect|settings|library|artifacts|approvals|notifications|preferences)/,
  );
  const c = location.hash.match(/^#connector\/([a-z0-9-]+)/);
  const modal = (c ? "connector" : m?.[3] || n?.[1] || "none") as ModalKind;
  return {
    chat: m?.[1] === "chat" ? m[2] : null,
    kitty: m?.[1] === "kitty" ? m[2] : null,
    modal,
    connector: c?.[1] || "",
  };
}

export default function App() {
  const [kitties, setKitties] = useState<Kitty[]>([]);
  const [chats, setChats] = useState<Session[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [current, setCurrent] = useState<string | null>(routeFromHash().chat);
  const [kittyOpen, setKittyOpen] = useState<string | null>(routeFromHash().kitty);
  const [modal, setModal] = useState<ModalKind>(routeFromHash().modal);
  // live is the kitty whose desktop is open live, over the chat.
  const [live, setLive] = useState<Kitty | null>(null);
  // lastChat is the chat open before a dialog's address took its place, to go back to.
  const lastChat = useRef<string | null>(routeFromHash().chat);
  // connectDismissed: the person closed the gateway dialog while the gateway is away; it is not
  // opened again by itself until the gateway has come back.
  const connectDismissed = useRef(false);
  useEffect(() => {
    if (current) {
      lastChat.current = current;
    }
  }, [current]);
  const [pending, setPending] = useState<string | null>(null);
  // pendingFrom is how many turns the chat had when the message went: the sending waits for the
  // kitties' answer, but the message itself arrives live before that, and is shown once.
  const [pendingFrom, setPendingFrom] = useState(0);
  const [error, setError] = useState("");
  // note is something to know that is not a failure of the page (a desktop that did not start).
  const [note, setNote] = useState("");
  const [version, setVersion] = useState("");
  const [sidebar, setSidebar] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  // How many actions wait for a yes; null when this gateway holds none back.
  const [waiting, setWaiting] = useState<number | null>(null);
  // Whether this page holds a session that can be ended (a gateway served on a network).
  const [canSignOut, setCanSignOut] = useState(false);
  const logoutURL = useRef("");
  // The models (to guide a first run) and whether the gateway can give kitties a desktop.
  const [models, setModels] = useState<ProviderInfo[]>([]);
  const [containers, setContainers] = useState(true);
  const [dockerState, setDockerState] = useState<"not_installed" | "not_running" | undefined>();
  const [runtime, setRuntime] = useState("container");
  const [runtimeError, setRuntimeError] = useState("");

  const user = t("You");

  const refresh = useCallback(async () => {
    try {
      const [k, c, h] = await Promise.all([api.kitties(), api.chats(), api.health()]);
      setKitties(k);
      setChats(c);
      setVersion(h.version || "");
      setContainers(h.containers !== false);
      setDockerState(h.containers_state);
      setRuntime(h.runtime || "container");
      setRuntimeError(h.containers_error || "");
      api
        .providers()
        .then(setModels)
        .catch(() => {});
      setOnline(true);
      setError("");
      connectDismissed.current = false;
      api
        .approvals("pending")
        .then((l) => setWaiting(l.length))
        .catch(() => setWaiting(null));
      if (cookieLogin()) {
        api
          .session()
          .then((s) => {
            setCanSignOut(s.signed_in && !s.local_token);
            logoutURL.current = s.logout_url === "/cdn-cgi/access/logout" ? s.logout_url : "";
          })
          .catch(() => setCanSignOut(false));
      }
    } catch (e) {
      setOnline(false);
      if (e instanceof ApiError && e.status === 401) {
        setModal(cookieLogin() ? "login" : "connect");
      } else {
        // In the app, no answer at all means no gateway: say what the app did about it and let
        // the person point it at another.
        let why = errText(e);
        const app = window.go?.main?.App;
        if (app && e instanceof ApiError && e.status === 0) {
          const note = await app.GatewayNote().catch(() => "");
          why = note ? `${why} (${note})` : why;
          if (!connectDismissed.current) {
            setModal((m) => (m === "none" ? "connect" : m));
          }
        }
        setError(why);
      }
    }
  }, []);

  const loadSession = useCallback(async (id: string) => {
    try {
      setSession(await api.chat(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Inside the macOS app the title bar is hidden and the window's buttons float over the page:
  // the CSS leaves room for them (see .mac-inset) and lets the top bars drag the window.
  useEffect(() => {
    if (inWails() && /Mac/i.test(navigator.userAgent)) {
      document.documentElement.classList.add("mac-inset");
    }
  }, []);

  // Whatever the page fails to do and nobody caught (a screen that cannot be drawn, a promise
  // nobody handled) is said in the banner, so a blank or stuck screen always has a reason.
  useEffect(() => {
    const onError = (e: ErrorEvent) =>
      setError(t("Something broke in the page: {message}", { message: e.message }));
    const onRejection = (e: PromiseRejectionEvent) =>
      setError(
        t("Something failed: {message}", {
          message: (e.reason as Error)?.message || String(e.reason),
        }),
      );
    addEventListener("error", onError);
    addEventListener("unhandledrejection", onRejection);
    return () => {
      removeEventListener("error", onError);
      removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  useEffect(() => {
    refresh();
    const onHash = () => {
      const r = routeFromHash();
      // A dialog's own address keeps the chat that was open behind it.
      setCurrent(r.chat || (/^#(new-|connector\/)/.test(location.hash) ? lastChat.current : null));
      setKittyOpen(r.kitty);
      // The address decides the dialog: one that no longer names it closes it, except the
      // sign-in and the gateway's, which the page opens itself.
      setModal((m) => (r.modal === "none" && (m === "login" || m === "connect") ? m : r.modal));
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, [refresh]);

  useEffect(() => {
    if (current) {
      loadSession(current);
    } else {
      setSession(null);
    }
  }, [current, loadSession]);

  const working = useMemo(() => Boolean(session?.turns?.some((t) => t.working)), [session]);
  // unshown is the message being sent until the chat itself has it.
  const unshown =
    pending !== null &&
    !(session?.turns || [])
      .slice(pendingFrom)
      .some((t) => !t.kitty && t.text.trim() === pending.trim())
      ? pending
      : null;

  // The open chat is watched live: every new turn, step and finish arrives as an event and is
  // merged into the session. A slow poll remains as the safety net.
  useEffect(() => {
    if (!current) {
      return;
    }
    return watchChat(current, (ev) => {
      if (ev.type === "deleted") {
        lastChat.current = null;
        location.hash = "";
        refresh();
        return;
      }
      if (ev.turn === undefined || ev.index === undefined) {
        return;
      }
      setSession((prev) => {
        if (!prev || prev.id !== ev.session) {
          return prev;
        }
        const turns = [...(prev.turns || [])];
        turns[ev.index!] = ev.turn!;
        return { ...prev, turns };
      });
      if (ev.type === "done") {
        refresh();
      }
    });
  }, [current, refresh]);
  const fleetChanging = kitties.some((k) => k.status === "starting" || k.status === "stopping");
  useEffect(() => {
    const id = setInterval(
      () => {
        refresh();
        if (current) {
          loadSession(current);
        }
      },
      fleetChanging ? 2000 : 15000,
    );
    return () => clearInterval(id);
  }, [current, refresh, loadSession, fleetChanging]);

  const workingChats = useMemo(() => {
    const set = new Set<string>();
    if (working && session) {
      set.add(session.id);
    }
    return set;
  }, [working, session]);
  const workingKitties = useMemo(() => {
    const set = new Set<string>();
    session?.turns?.forEach((t) => t.working && t.kitty && set.add(t.kitty));
    return set;
  }, [session]);

  // go opens a route; the same route again still opens its dialog (no hashchange fires then).
  const go = (hash: string) => {
    if (location.hash === hash) {
      setModal(routeFromHash().modal);
    } else {
      location.hash = hash;
    }
  };
  // closeModal closes a dialog, and takes it out of the address, so a reload or the same link
  // does not open it again; the chat that was open stays.
  const closeModal = () => {
    setModal("none");
    const h = location.hash;
    const nested = h.match(/^(#(?:chat|kitty)\/[a-z0-9-]+)\/new-[a-z-]+$/);
    if (nested) {
      location.hash = nested[1];
    } else if (/^#(new-|connector\/)/.test(h)) {
      location.hash = lastChat.current ? `#chat/${lastChat.current}` : "";
    }
  };

  const openChat = (id: string) => {
    location.hash = `#chat/${id}`;
    setSidebar(false);
  };
  const openKitty = (id: string) => {
    location.hash = `#kitty/${id}`;
    setSidebar(false);
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    if (logoutURL.current) {
      location.assign(logoutURL.current);
      return;
    }
    setCanSignOut(false);
    setSession(null);
    setChats([]);
    setKitties([]);
    lastChat.current = null;
    location.hash = "";
    setModal("login");
  };

  const send = async (text: string) => {
    if (!session) {
      return;
    }
    setPendingFrom((session.turns || []).length);
    setPending(text);
    setError("");
    try {
      await api.send(session.id, text);
    } catch (e) {
      setError((e as Error).message);
    }
    setPending(null);
    await loadSession(session.id);
    refresh();
  };

  const cancel = async () => {
    if (session) {
      await api.cancel(session.id).catch(() => {});
      loadSession(session.id);
    }
  };

  const deleteChat = async () => {
    if (
      session &&
      (await ask(t('Delete the chat "{title}"?', { title: session.title }), t("Delete")))
    ) {
      await api.deleteChat(session.id).catch((e) => setError(e.message));
      lastChat.current = null;
      location.hash = "";
      refresh();
    }
  };

  const members = session
    ? session.members.map((id) => kitties.find((k) => k.id === id)).filter(Boolean)
    : [];
  const kitty = kittyOpen
    ? kitties.find((k) => k.id === kittyOpen || k.name === kittyOpen)
    : undefined;

  return (
    <div class="app-bg h-full flex overflow-hidden">
      <ConfirmHost />
      <Sidebar
        chats={chats}
        kitties={kitties}
        current={current}
        workingChats={workingChats}
        workingKitties={workingKitties}
        version={version}
        open={sidebar}
        onClose={() => setSidebar(false)}
        onOpenChat={openChat}
        onOpenKitty={openKitty}
        onNewChat={() => setModal("chat")}
        onNewKitty={() => setModal("kitty")}
        onSettings={() => setModal("settings")}
        onLibrary={() => setModal("library")}
        onApprovals={() => {
          location.hash = "#new-approvals";
        }}
        approvals={waiting}
        onTheme={cycleMode}
        onSignOut={canSignOut ? signOut : undefined}
      />
      <div class="flex-1 flex flex-col min-w-0">
        <header class="titlebar frosted flex items-center gap-3 px-3 sm:px-5 py-2.5 border-b border-white/5 flex-none z-10">
          <button
            class="plain p-1.5 md:hidden"
            onClick={() => setSidebar(true)}
            aria-label={t("Menu")}
          >
            <IconMenu />
          </button>
          <h1 class="text-sm sm:text-base font-semibold tracking-wide truncate min-w-0 flex-1">
            {session ? session.title : "Kitties"}
          </h1>
          {session && session.members.length > 1 && (
            <span class="tag tag-accent">
              <IconUsers size={10} /> {t("group")}
            </span>
          )}
          {members.map((k) => (
            <span key={k!.id} class="hidden sm:inline-flex tag items-center">
              <PixelCat
                breed={k!.avatar?.breed}
                color={k!.avatar?.color}
                mood={workingKitties.has(k!.id) ? "working" : pending ? "thinking" : moodOf(k!)}
                size={18}
              />{" "}
              {k!.name}
            </span>
          ))}
          {members
            .filter((k) => k!.desktop && k!.status === "running")
            .map((k) => (
              <button
                key={"live-" + k!.id}
                class="btn-ghost px-2 py-1 text-xs flex items-center gap-1"
                onClick={() => setLive(k!)}
                title={t("See {name}'s desktop live, and take control of it", { name: k!.name })}
                data-testid="open-desktop"
              >
                <IconMonitor size={13} />
                <span class="hidden sm:inline">{members.length > 1 ? k!.name : t("Desktop")}</span>
              </button>
            ))}
          <span
            class={`state-pill ${working ? "is-working" : online === false ? "is-off" : "is-ok"}`}
          >
            {working && <span class="spinner" />}
            {working ? t("working") : online === false ? t("offline") : t("connected")}
          </span>
          {session && (
            <button class="btn-ghost p-2" onClick={deleteChat} aria-label={t("Delete chat")}>
              <IconTrash size={14} />
            </button>
          )}
        </header>
        {error && (
          <div class="px-4 py-2 text-sm bg-[rgba(255,107,107,0.12)] text-[var(--c-red)] border-b border-[rgba(255,107,107,0.3)]">
            {error}
          </div>
        )}
        {note && (
          <div
            class="callout callout-warn !border-x-0 !border-t-0 flex items-start gap-2"
            role="status"
            data-testid="note"
          >
            <span class="flex-1">{note}</span>
            <button
              class="plain text-xs text-[var(--t3)]"
              onClick={() => setNote("")}
              aria-label={t("Dismiss")}
            >
              ✕
            </button>
          </div>
        )}
        {live && <LiveDesktop kitty={live} onClose={() => setLive(null)} />}
        {current ? (
          <Conversation
            session={session}
            kitties={kitties}
            user={user}
            pending={unshown}
            waiting={pending !== null && !working}
            onSend={send}
          />
        ) : (
          <Welcome
            models={models}
            kitties={kitties}
            chats={chats}
            onAddModel={() => go("#new-models-add")}
            onNewKitty={() => setModal("kitty")}
            onNewChat={() => setModal("chat")}
            onConnections={() => go("#new-connectors-add")}
            onNotifications={() => go("#new-notifications")}
          />
        )}
        {session && (
          <Composer
            disabled={pending !== null || working}
            working={working}
            group={session.members.length > 1}
            onSend={send}
            onCancel={cancel}
          />
        )}
      </div>

      {modal === "chat" && (
        <NewChatModal
          kitties={kitties}
          onNeedKitty={() => setModal("kitty")}
          onClose={closeModal}
          onCreated={(id) => {
            setModal("none");
            refresh();
            openChat(id);
          }}
        />
      )}
      {modal === "kitty" && (
        <NewKittyModal
          containers={containers}
          dockerState={dockerState}
          runtime={runtime}
          runtimeError={runtimeError}
          taken={kitties.map((k) => k.name)}
          onNeedModel={() => {
            go("#new-models-add");
          }}
          onClose={closeModal}
          onCreated={(note) => {
            setModal("none");
            refresh();
            setNote(note || "");
          }}
        />
      )}
      {(modal === "library" || modal === "artifacts") && (
        <LibraryModal
          initial={modal === "artifacts" ? "artifacts" : "skills"}
          onClose={closeModal}
        />
      )}
      {modal === "approvals" && (
        <ApprovalsModal
          kitties={kitties}
          onClose={closeModal}
          onChanged={refresh}
          onOpenChat={openChat}
        />
      )}
      {(modal === "settings" ||
        modal === "models-add" ||
        modal === "connectors" ||
        modal === "connectors-add" ||
        modal === "connector" ||
        modal === "notifications" ||
        modal === "preferences") && (
        <SettingsModal
          initial={
            modal === "settings" || modal === "models-add"
              ? "models"
              : modal === "notifications" || modal === "preferences"
                ? modal
                : "connectors"
          }
          addModel={modal === "models-add"}
          addConnector={modal === "connectors-add"}
          editConnector={modal === "connector" ? routeFromHash().connector : undefined}
          kitties={kitties}
          onKittiesChanged={refresh}
          onClose={() => {
            closeModal();
            refresh();
          }}
        />
      )}
      {modal === "login" && (
        <Login
          onDone={() => {
            setModal("none");
            refresh();
          }}
        />
      )}
      {modal === "connect" && (
        <ConnectModal
          onClose={() => {
            connectDismissed.current = online === false;
            closeModal();
          }}
          reason={
            online === false
              ? error || t("The gateway did not answer or refused the token.")
              : undefined
          }
          onDone={() => {
            setModal("none");
            refresh();
          }}
        />
      )}
      {kitty && (
        <KittyDrawer
          kitty={kitty}
          kitties={kitties}
          runtime={runtime}
          onOpenChat={openChat}
          onClose={() => {
            location.hash = lastChat.current ? `#chat/${lastChat.current}` : "";
          }}
          onChanged={refresh}
          onChat={async () => {
            const s = await api.createChat("", [kitty.id]);
            refresh();
            openChat(s.id);
          }}
        />
      )}
    </div>
  );
}
