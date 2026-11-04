import { t } from "./i18n";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const FileFailure = Schema.Struct({ code: Schema.optional(Schema.String) });
const parseFileFailure = Schema.decodeUnknownOption(FileFailure);

export const FILE_LIMIT = 64 * 1024 * 1024;

export interface DesktopFile {
  name: string;
  path: string;
  directory: boolean;
  size: number;
  modifiedAt: string;
}

export interface DesktopFiles {
  path: string;
  generation: number;
  truncated: boolean;
  files: DesktopFile[];
}

export const fileEndpoint = (id: string) => `/v1/kitties/${encodeURIComponent(id)}/files`;

export const fileSize = (size: number) =>
  size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;

export function fileError(code: string): Error {
  const messages = new Map(
    Object.entries({
      FILE_TOO_LARGE: t("Choose a file no larger than 64 MB."),
      FILE_NOT_FOUND_OR_SHARING_NOT_READY: t(
        "Shared folder unavailable. Start or upgrade this computer, then try again.",
      ),
      FILE_NOT_FOUND: t("This file has moved or was removed. Refresh the folder."),
      COMPUTER_NOT_READY_OR_BUSY: t(
        "Start the computer and wait for it to be ready, then try again.",
      ),
      COMPUTER_CHANGED: t("The computer changed. Refresh the folder before transferring files."),
      INVALID_FILE_NAME: t(
        "Choose a file with a shorter name, without slashes or control characters.",
      ),
      INVALID_FILE_PATH: t(
        "Choose a file with a shorter name, without slashes or control characters.",
      ),
    }),
  );

  return Error(
    messages.get(code) ?? t("Transfer could not be confirmed. Refresh the folder before retrying."),
  );
}

export async function fileResponse(response: Response) {
  if (!response.ok) {
    const error = parseFileFailure(await response.json().catch(() => ({})));
    throw fileError(Option.isSome(error) ? (error.value.code ?? "") : "");
  }

  return response;
}

export function uploadFile(
  url: string,
  file: File,
  signal: AbortSignal,
  progress: (percent: number) => void,
) {
  if (file.size > FILE_LIMIT) return Promise.reject(fileError("FILE_TOO_LARGE"));

  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const cancel = () => xhr.abort();

    const finish = (error?: Error) => {
      signal.removeEventListener("abort", cancel);

      if (error) reject(error);
      else resolve();
    };

    xhr.open("POST", url);
    xhr.setRequestHeader("X-File-Size", String(file.size));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = 5 * 60_000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        progress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        progress(100);
        finish();
      } else {
        let code = "";

        try {
          const error = parseFileFailure(JSON.parse(xhr.responseText));
          code = Option.isSome(error) ? (error.value.code ?? "") : "";
        } catch {}

        finish(fileError(code));
      }
    };

    xhr.onerror = xhr.ontimeout = () => finish(fileError(""));
    xhr.onabort = () => finish(new DOMException("Transfer cancelled", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });

    if (signal.aborted) {
      finish(new DOMException("Transfer cancelled", "AbortError"));

      return;
    }

    xhr.send(file);
  });
}

export async function downloadFile(
  url: string,
  name: string,
  signal: AbortSignal,
  progress: (percent: number) => void,
) {
  const response = await fileResponse(await fetch(url, { signal }));

  if (!response.body) throw fileError("");

  const reader = response.body.getReader(),
    chunks: Uint8Array<ArrayBuffer>[] = [];

  const total = Number(response.headers.get("Content-Length"));
  let size = 0;

  try {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) break;
      size += value.byteLength;

      if (size > FILE_LIMIT) throw fileError("FILE_TOO_LARGE");
      chunks.push(new Uint8Array(value));

      if (total) progress(Math.min(99, Math.round((size / total) * 100)));
    }

    if (signal.aborted) throw new DOMException("Transfer cancelled", "AbortError");
    const blobUrl = URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    progress(100);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
