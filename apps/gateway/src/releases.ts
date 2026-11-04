const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function releaseSignature(key: string, name: string, expires: number) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return hex(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(`kittyd:${name}:${expires}`),
    ),
  );
}

export async function releaseUrl(
  base: string,
  key: string,
  name: string,
  expires = Date.now() + 3600000,
) {
  if (!/^[a-f0-9]{64}\.tgz$/.test(name)) throw Error("INVALID_RELEASE");

  return `${base}/releases/${name}?expires=${expires}&signature=${await releaseSignature(key, name, expires)}`;
}
