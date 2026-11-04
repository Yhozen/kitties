import * as Cloudflare from "@alchemy.run/cloudflare";

// This bucket belongs to the rewrite. Legacy Go buckets are not referenced here.
export const GuestAssets = Cloudflare.R2.Bucket("GuestAssets", { locationHint: "weur" });

export const RetainedExports = Cloudflare.R2.Bucket("RetainedExports", {
  locationHint: "weur",
  locks: [
    {
      id: "retain-30-days",
      enabled: true,
      prefix: "exports/",
      condition: { type: "Age", maxAgeSeconds: 30 * 86400 },
    },
  ],
  lifecycleRules: [
    {
      id: "expire-after-90-days",
      enabled: true,
      prefix: "exports/",
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 90 * 86400 } },
    },
  ],
});
