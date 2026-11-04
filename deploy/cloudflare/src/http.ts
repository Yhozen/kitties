export function sameOrigin(request: Request, publicURL: string): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== publicURL) return false;
  const unsafe =
    !["GET", "HEAD", "OPTIONS"].includes(request.method) ||
    request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  return (
    !unsafe ||
    origin === publicURL ||
    request.headers.get("Sec-Fetch-Site") === "same-origin"
  );
}

export function gatewayRequest(
  request: Request,
  token: string,
  publicURL: string,
): Request {
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-Forwarded-Proto", "https");
  headers.set("X-Forwarded-Host", new URL(publicURL).host);
  headers.delete("X-Forwarded-For");
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) headers.set("X-Forwarded-For", ip);
  const url = new URL(request.url);
  url.searchParams.delete("token");
  return new Request(url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}

export function containerRequest(request: Request): Request {
  const url = new URL(request.url);
  url.protocol = "http:";
  return new Request(url, request);
}
