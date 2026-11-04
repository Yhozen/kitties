import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "./i18n";
import { call } from "./next-api";
import {
  fileEndpoint,
  fileSize,
  fileResponse,
  uploadFile,
  downloadFile,
  type DesktopFiles as Listing,
} from "./desktop-files";

export function DesktopFiles({ id }: { id: string }) {
  const [path, setPath] = useState(""),
    [listing, setListing] = useState<Listing>(),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [refresh, setRefresh] = useState(0),
    [artifacts, setArtifacts] = useState<readonly { id: string; name: string; size: number }[]>([]);
  const operation = useRef<AbortController | undefined>(undefined),
    fileInput = useRef<HTMLInputElement>(null);
  const base = fileEndpoint(id);
  useEffect(() => () => operation.current?.abort(), [id]);
  useEffect(() => {
    const abort = new AbortController();
    setListing(undefined);
    void fetch(`${base}?path=${encodeURIComponent(path)}`, { signal: abort.signal })
      .then(fileResponse)
      .then((response) => response.json())
      .then((value) => {
        if (!abort.signal.aborted) setListing(value);
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(reason.message);
      });
    void call((api) => api.workspace.artifacts())
      .then((value) => {
        if (!abort.signal.aborted) setArtifacts(value);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [base, path, refresh]);
  const run = async (label: string, task: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current || !listing) return;
    const abort = new AbortController();
    operation.current = abort;
    setBusy(true);
    setProgress(0);
    setStatus(label);
    setError("");
    try {
      await task(abort.signal);
      if (!abort.signal.aborted) setStatus(t("Transfer complete."));
    } catch (reason) {
      setStatus("");
      setError(
        abort.signal.aborted
          ? t("Transfer stopped. Refresh the folder to check whether the file arrived.")
          : reason instanceof Error
            ? reason.message
            : t("Transfer failed."),
      );
    } finally {
      if (operation.current === abort) {
        operation.current = undefined;
        setBusy(false);
        setRefresh((value) => value + 1);
      }
    }
  };
  const query = () => new URLSearchParams({ path, generation: String(listing!.generation) });
  const upload = (file?: File) => {
    if (!file || !listing || busy) return;
    const params = query();
    params.set("name", file.name);
    void run(`${t("Uploading")} ${file.name}`, (signal) =>
      uploadFile(`${base}?${params}`, file, signal, setProgress),
    );
  };
  return (
    <section
      class="desktop-files"
      aria-label={t("Desktop files")}
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer?.files.length) return;
        event.preventDefault();
        if (event.dataTransfer.files.length !== 1) {
          setError(t("Choose one file at a time."));
          return;
        }
        upload(event.dataTransfer.files[0]);
      }}
    >
      <div class="desktop-files-heading">
        <strong>{t("Shared files")}</strong>
        <button
          disabled={busy}
          onClick={() => {
            setError("");
            setRefresh((value) => value + 1);
          }}
        >
          {t("Refresh")}
        </button>
      </div>
      <p>
        {t(
          "Drop a file here or choose one to upload. Open Shared on the desktop to use it. Save desktop files there to download them here.",
        )}
      </p>
      <div class="desktop-files-actions">
        {path && (
          <button disabled={busy} onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}>
            {t("Up one folder")}
          </button>
        )}
        <code>{path ? `Shared/${path}` : "Shared"}</code>
        <button disabled={!listing || busy} onClick={() => fileInput.current?.click()}>
          {t("Upload file")}
        </button>
        <small>{t("Up to 64 MB. Uploads keep both copies.")}</small>
        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={(event) => {
            upload(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
      </div>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      {busy && (
        <div class="desktop-files-actions">
          <progress aria-label={t("Transfer progress")} max={100} value={progress} />
          <span>{progress}%</span>
          <button onClick={() => operation.current?.abort()}>{t("Cancel transfer")}</button>
        </div>
      )}
      {!listing && !error && <p>{t("Loading files…")}</p>}
      {listing && (
        <ul class="desktop-files-list">
          {listing.files.map((file) => (
            <li key={file.path}>
              <span>
                {file.directory ? "📁 " : ""}
                {file.name}
              </span>
              <small>{file.directory ? t("Folder") : fileSize(file.size)}</small>
              <button
                disabled={busy}
                onClick={() => {
                  if (file.directory) {
                    setPath(file.path);
                    return;
                  }
                  const params = new URLSearchParams({
                    path: file.path,
                    generation: String(listing.generation),
                  });
                  void run(`${t("Downloading")} ${file.name}`, (signal) =>
                    downloadFile(`${base}/download?${params}`, file.name, signal, setProgress),
                  );
                }}
              >
                {file.directory ? t("Open folder") : t("Download")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {listing && !listing.files.length && <p>{t("No shared files yet.")}</p>}
      {listing?.truncated && (
        <p>
          {t(
            "This folder has more files than can be listed. Use smaller subfolders to find them all.",
          )}
        </p>
      )}
      {artifacts.length > 0 && (
        <details>
          <summary>{t("Send a Library file to this desktop")}</summary>
          <ul class="desktop-files-list">
            {artifacts.map((file) => (
              <li key={file.id}>
                <span>{file.name}</span>
                <small>{fileSize(file.size)}</small>
                <button
                  disabled={!listing || busy}
                  onClick={() => {
                    const params = query();
                    params.set("artifact", file.id);
                    void run(`${t("Sending")} ${file.name}`, async (signal) => {
                      await fileResponse(
                        await fetch(`${base}/from-library?${params}`, { method: "POST", signal }),
                      );
                    });
                  }}
                >
                  {t("Send to desktop")}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
