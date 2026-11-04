export async function verifyWebhook(
  kind: "github" | "stripe" | "generic",
  secret: string,
  headers: Record<string, string>,
  body: string,
  now = Date.now(),
): Promise<string | null> {
  let delivery = "",
    signed = body,
    signatures: string[] = [];
  if (kind === "github") {
    delivery = headers["x-github-delivery"] ?? "";
    signatures = [(headers["x-hub-signature-256"] ?? "").replace(/^sha256=/, "")];
  } else {
    let timestamp = "";
    if (kind === "stripe") {
      const fields = (headers["stripe-signature"] ?? "").split(",");
      timestamp = fields.find((value) => value.startsWith("t="))?.slice(2) ?? "";
      signatures = fields
        .filter((value) => value.startsWith("v1="))
        .slice(0, 10)
        .map((value) => value.slice(3));
      try {
        delivery = JSON.parse(body).id ?? "";
      } catch {
        return null;
      }
    } else {
      timestamp = headers["x-kitties-timestamp"] ?? "";
      signatures = [(headers["x-kitties-signature"] ?? "").replace(/^sha256=/, "")];
      delivery = headers["x-kitties-delivery"] ?? "";
    }
    if (!/^\d{10}$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 300000)
      return null;
    signed = `${timestamp}.${body}`;
  }
  if (typeof delivery !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(delivery)) return null;
  const encoder = new TextEncoder(),
    key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
  for (const signature of signatures) {
    if (!/^[a-f0-9]{64}$/i.test(signature)) continue;
    const bytes = Uint8Array.from(signature.match(/../g)!, (value) => parseInt(value, 16));
    if (await crypto.subtle.verify("HMAC", key, bytes, encoder.encode(signed))) return delivery;
  }
  return null;
}
