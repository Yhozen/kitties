import { useEffect, useState } from "preact/hooks";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { client } from "@kitties/api";
import PixelCat from "./PixelCat";

export default function NextShell() {
  const [status, setStatus] = useState("Conectando…");
  useEffect(() => {
    void Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* client;
        const health = yield* api.system.health();
        setStatus(health.ok ? "Tu espacio está listo." : "Reconectando…");
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    ).catch(() => setStatus("Sin conexión. Vuelve a abrir la app cuando tengas conexión."));
  }, []);
  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "2rem" }}>
      <section style={{ textAlign: "center", maxWidth: "32rem" }}>
        <PixelCat breed="tabby" color="mint" size={96} />
        <h1 style={{ fontSize: "2rem", marginTop: "1rem" }}>Kitties</h1>
        <p role="status">{status}</p>
      </section>
    </main>
  );
}
