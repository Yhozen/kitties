import { decodeCommit, ProtocolError, type Mutation } from "./protocol.ts";
import type { MetadataStorage } from "./state.ts";

type Session = {
  id: string;
  epoch: number;
  files: number;
  batches: number;
  next: number;
};

export class StagedImport {
  constructor(
    private readonly storage: MetadataStorage,
    private readonly assertEpoch: (epoch: number) => void,
    private readonly verifyParts: (mutations: Mutation[]) => Promise<void>,
  ) {
    for (const query of [
      "CREATE TABLE IF NOT EXISTS state_import (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL, epoch INTEGER NOT NULL, files INTEGER NOT NULL, batches INTEGER NOT NULL, next INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS import_files (path TEXT PRIMARY KEY, mode INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS import_parts (path TEXT NOT NULL, ordinal INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(path, ordinal))",
      "CREATE TABLE IF NOT EXISTS import_batches (ordinal INTEGER PRIMARY KEY, digest TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS import_receipts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL)",
    ])
      storage.sql.exec(query);
  }

  pending(): boolean {
    return this.session() !== undefined;
  }

  async handle(
    action: string,
    input: unknown,
    epoch: number,
  ): Promise<Response> {
    this.assertEpoch(epoch);
    if (typeof input !== "object" || input === null || Array.isArray(input))
      throw new ProtocolError("Expected an import object");
    const body = input as Record<string, unknown>;
    if (typeof body.id !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.id))
      throw new ProtocolError("Invalid import id");
    const id = body.id;
    if (action === "begin") {
      if (
        !Number.isSafeInteger(body.files) ||
        Number(body.files) < 0 ||
        !Number.isSafeInteger(body.batches) ||
        Number(body.batches) < 0 ||
        Number(body.batches) > Number(body.files) ||
        (body.files === 0) !== (body.batches === 0)
      )
        throw new ProtocolError("Invalid import file or batch count");
      this.empty();
      const current = this.session();
      if (current?.epoch === epoch) {
        if (
          current.id !== id ||
          current.files !== body.files ||
          current.batches !== body.batches
        )
          throw new ProtocolError("Another import is already staged", 409);
      } else {
        this.storage.transactionSync(() => {
          this.clear();
          this.storage.sql.exec(
            "INSERT INTO state_import VALUES (1, ?, ?, ?, ?, 0)",
            id,
            epoch,
            Number(body.files),
            Number(body.batches),
          );
        });
      }
      await this.storage.sync();
      return Response.json({ next: this.session()!.next });
    }
    if (action === "finalize") {
      const receipt = this.storage.sql
        .exec<{
          revision: number;
        }>("SELECT revision FROM import_receipts WHERE id = ?", id)
        .toArray()[0];
      if (receipt) {
        await this.storage.sync();
        return Response.json(receipt);
      }
      const session = this.match(id, epoch);
      this.empty();
      const count = this.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM import_files")
        .toArray()[0].count;
      if (session.next !== session.batches || count !== session.files)
        throw new ProtocolError("The staged import is incomplete", 409);
      this.storage.transactionSync(() => {
        this.storage.sql.exec(
          "INSERT INTO state_files SELECT path, mode FROM import_files",
        );
        this.storage.sql.exec(
          "INSERT INTO state_parts SELECT path, ordinal, sha256, size FROM import_parts",
        );
        this.storage.sql.exec(
          "INSERT OR REPLACE INTO state_meta VALUES ('revision', 1)",
        );
        this.storage.sql.exec("INSERT INTO import_receipts VALUES (?, 1)", id);
        this.clear();
      });
      await this.storage.sync();
      return Response.json({ revision: 1 });
    }
    if (action !== "batch")
      throw new ProtocolError("Unknown import action", 404);
    const session = this.match(id, epoch);
    this.empty();
    if (
      !Number.isSafeInteger(body.index) ||
      Number(body.index) < 0 ||
      Number(body.index) >= session.batches
    )
      throw new ProtocolError("Invalid import batch index");
    const index = Number(body.index);
    const commit = decodeCommit({
      id,
      baseRevision: 0,
      mutations: body.mutations,
    });
    if (commit.mutations.some((mutation) => mutation.op !== "put"))
      throw new ProtocolError("Imports only accept put mutations");
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(commit.mutations)),
    );
    const digest = Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    this.assertEpoch(epoch);
    const previous = this.storage.sql
      .exec<{
        digest: string;
      }>("SELECT digest FROM import_batches WHERE ordinal = ?", index)
      .toArray()[0];
    if (previous) {
      if (previous.digest !== digest)
        throw new ProtocolError(
          "Import batch was reused with different content",
          409,
        );
      await this.storage.sync();
      return Response.json({ next: session.next });
    }
    if (index !== session.next)
      throw new ProtocolError("Import batches must arrive in order", 409);
    const paths = new Set<string>();
    for (const mutation of commit.mutations) {
      if (
        paths.has(mutation.path) ||
        this.storage.sql
          .exec("SELECT path FROM import_files WHERE path = ?", mutation.path)
          .toArray().length
      )
        throw new ProtocolError("Import contains duplicate paths", 409);
      paths.add(mutation.path);
    }
    const staged = this.storage.sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM import_files")
      .toArray()[0].count;
    if (staged + paths.size > session.files)
      throw new ProtocolError("Import exceeds its declared file count", 409);
    await this.verifyParts(commit.mutations);
    this.storage.transactionSync(() => {
      this.assertEpoch(epoch);
      this.empty();
      for (const mutation of commit.mutations) {
        this.storage.sql.exec(
          "INSERT INTO import_files VALUES (?, ?)",
          mutation.path,
          mutation.mode!,
        );
        for (const [ordinal, part] of (mutation.parts ?? []).entries())
          this.storage.sql.exec(
            "INSERT INTO import_parts VALUES (?, ?, ?, ?)",
            mutation.path,
            ordinal,
            part.sha256,
            part.size,
          );
      }
      this.storage.sql.exec(
        "INSERT INTO import_batches VALUES (?, ?)",
        index,
        digest,
      );
      this.storage.sql.exec(
        "UPDATE state_import SET next = ? WHERE singleton = 1",
        index + 1,
      );
    });
    await this.storage.sync();
    return Response.json({ next: index + 1 });
  }

  private session(): Session | undefined {
    return this.storage.sql
      .exec<Session>(
        "SELECT id, epoch, files, batches, next FROM state_import WHERE singleton = 1",
      )
      .toArray()[0];
  }

  private match(id: string, epoch: number): Session {
    const session = this.session();
    if (!session || session.id !== id || session.epoch !== epoch)
      throw new ProtocolError(
        "No matching import is staged for this gateway",
        409,
      );
    return session;
  }

  private empty(): void {
    const revision =
      this.storage.sql
        .exec<{
          value: number;
        }>("SELECT value FROM state_meta WHERE key = 'revision'")
        .toArray()[0]?.value ?? 0;
    if (
      revision !== 0 ||
      this.storage.sql.exec("SELECT path FROM state_files LIMIT 1").toArray()
        .length
    )
      throw new ProtocolError("Import requires an empty gateway", 409);
  }

  private clear(): void {
    for (const table of [
      "state_import",
      "import_files",
      "import_parts",
      "import_batches",
    ])
      this.storage.sql.exec(`DELETE FROM ${table}`);
  }
}
