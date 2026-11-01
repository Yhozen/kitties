export interface Envelope {
  kid: string;
  iv: string;
  ct: string;
}
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
const key = (hex: string) => {
  if (!/^[a-f0-9]{64}$/.test(hex)) throw Error("KEY_UNAVAILABLE");
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(hex.match(/../g)!, (part) => parseInt(part, 16)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
};
export async function seal(kek: string, aad: string, value: string): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    await key(kek),
    new TextEncoder().encode(value),
  );
  return { kid: "v1", iv: encode(iv), ct: encode(new Uint8Array(ct)) };
}
export async function open(kek: string, aad: string, envelope: Envelope): Promise<string> {
  if (envelope.kid !== "v1") throw Error("KEY_VERSION_UNAVAILABLE");
  const value = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(envelope.iv), additionalData: new TextEncoder().encode(aad) },
    await key(kek),
    decode(envelope.ct),
  );
  return new TextDecoder().decode(value);
}
