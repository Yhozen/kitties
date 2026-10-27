export interface Part {
  sha256: string;
  size: number;
}

export interface FileEntry {
  path: string;
  mode: number;
  parts: Part[];
}

export interface Manifest {
  revision: number;
  files: FileEntry[];
}

export interface Mutation {
  op: "put" | "append" | "delete";
  path: string;
  mode?: number;
  parts?: Part[];
  recursive?: boolean;
}

export interface Commit {
  id: string;
  baseRevision: number;
  mutations: Mutation[];
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function isHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function validPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\\\x00-\x1f\x7f]/.test(value) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError("Expected an object");
  }
  return value as Record<string, unknown>;
}

export function decodeCommit(value: unknown): Commit {
  const body = record(value);
  if (
    typeof body.id !== "string" ||
    !/^[a-zA-Z0-9_-]{16,128}$/.test(body.id) ||
    !Number.isSafeInteger(body.baseRevision) ||
    Number(body.baseRevision) < 0 ||
    !Array.isArray(body.mutations) ||
    body.mutations.length === 0 ||
    body.mutations.length > 256
  ) {
    throw new ProtocolError("Invalid commit id, revision, or mutations");
  }
  const mutations = body.mutations.map((raw): Mutation => {
    const item = record(raw);
    if (typeof item.path !== "string" || !validPath(item.path)) {
      throw new ProtocolError(
        "Paths must be normalized and relative to the state directory",
      );
    }
    if (item.op === "delete") {
      if (item.recursive !== undefined && typeof item.recursive !== "boolean") {
        throw new ProtocolError("Invalid recursive flag");
      }
      return { op: "delete", path: item.path, recursive: item.recursive };
    }
    if (
      (item.op !== "put" && item.op !== "append") ||
      !Number.isInteger(item.mode) ||
      Number(item.mode) < 0 ||
      Number(item.mode) > 0o777 ||
      (item.parts !== undefined && !Array.isArray(item.parts))
    ) {
      throw new ProtocolError("Invalid write mutation");
    }
    const parts = (item.parts ?? []).map((rawPart: unknown): Part => {
      const part = record(rawPart);
      if (
        typeof part.sha256 !== "string" ||
        !isHash(part.sha256) ||
        !Number.isSafeInteger(part.size) ||
        Number(part.size) < 0
      ) {
        throw new ProtocolError("Invalid blob reference");
      }
      return { sha256: part.sha256, size: Number(part.size) };
    });
    return { op: item.op, path: item.path, mode: Number(item.mode), parts };
  });
  return { id: body.id, baseRevision: Number(body.baseRevision), mutations };
}

export function applyCommit(current: Manifest, commit: Commit): Manifest {
  if (commit.baseRevision !== current.revision)
    throw new ProtocolError("State revision changed", 409);
  const files = new Map(
    current.files.map((file) => [file.path, structuredClone(file)]),
  );
  for (const mutation of commit.mutations) {
    if (mutation.op === "delete") {
      files.delete(mutation.path);
      if (mutation.recursive) {
        for (const path of files.keys()) {
          if (path.startsWith(`${mutation.path}/`)) files.delete(path);
        }
      }
    } else {
      const previous = files.get(mutation.path);
      files.set(mutation.path, {
        path: mutation.path,
        mode: mutation.mode ?? 0o600,
        parts:
          mutation.op === "append"
            ? [...(previous?.parts ?? []), ...(mutation.parts ?? [])]
            : [...(mutation.parts ?? [])],
      });
    }
  }
  return {
    revision: current.revision + 1,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}
