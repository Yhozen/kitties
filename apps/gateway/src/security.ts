import type { ApiError } from "@kitties/domain";

export function ownerError(
  request: Request,
  publicUrl: string,
  ownerEmail: string,
  identity: { email?: string } | undefined,
): { status: number; body: ApiError } | undefined {
  const deny = (status: number, code: ApiError["code"]) => ({ status, body: { code, params: {} } });

  if (new URL(request.url).origin !== publicUrl) return deny(404, "NOT_FOUND");

  if (!identity) return deny(403, "ACCESS_REQUIRED");

  if (identity.email?.toLowerCase() !== ownerEmail.toLowerCase()) return deny(403, "ACCESS_DENIED");

  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    if (request.headers.get("Origin") !== publicUrl) return deny(403, "ORIGIN_DENIED");
    const site = request.headers.get("Sec-Fetch-Site");

    if (site && site !== "same-origin") return deny(403, "ORIGIN_DENIED");
  }

  return undefined;
}
