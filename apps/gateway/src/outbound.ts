export function publicHttps(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !host.includes(".") ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    /^\d+\./.test(host) ||
    host.includes(":")
  )
    throw Error("HOST_DENIED");
  return url;
}
export async function allowedFetch(
  value: string,
  hosts: readonly string[],
  init: RequestInit = {},
): Promise<Response> {
  const url = publicHttps(value);
  if (!hosts.includes(url.hostname)) throw Error("HOST_DENIED");
  // Redirects need a fresh host and risk decision; never forward a bearer token.
  const response = await fetch(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw Error("REDIRECT_DENIED");
  return response;
}
