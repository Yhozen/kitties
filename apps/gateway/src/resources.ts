import * as Cloudflare from "@alchemy.run/cloudflare";
// This bucket belongs to the rewrite. Legacy Go buckets are not referenced here.
export const GuestAssets = Cloudflare.R2.Bucket("GuestAssets", { locationHint: "weur" });
