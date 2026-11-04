# bot-avatar

Vendored from [open-bot-avatar](https://github.com/DominikScholz/open-bot-avatar)
(`packages/core/src`, commit `dadfac3`, 2026-11-04), MIT licensed — see `LICENSE`.
It renders the puppy avatars (`../puppies.ts`, `../PuppyAvatar.tsx`).

## Puppies extension

One addition, the optional `skin` render option (`AvatarSkin` in `types.ts`), changes
`render.ts`, `types.ts`, `index.ts` and `dom/mount.ts`. Without a skin the output is upstream's.

- `parts`: a color per part (subpath), e.g. ears darker than the head.
- `shade`: darkens cross-sections toward each part's rim for a soft, clay-like gradient.
- `decals`: paths painted on the eye part (muzzle, nose, smile, markings), drawn into each
  front-facing cross-section and masked to it, so they sit on the surface as the head turns.
  Side views (past 45°) use the side cross-sections, which carry no decals.
- `offsets`: shifts parts along depth, e.g. ears set behind the head.
- `eyeWidth`, `eyeShine`: rounder eyes and a highlight in them.

With a skin no cross-section is culled (the gradient and decals live on the front ones), and the
fill and decals of a slice share one `<mask>`: `clip-path` leaves a hairline of the fill along each
slice edge in Chrome. Live scenes give their masks unique ids, since a `url(#id)` pointing into
another avatar's hidden slice masks nothing.

To update, copy `packages/core/src` from a newer upstream commit, reapply the extension (search
for "Puppies extension" and `skin`), keep this file and `LICENSE`, and run `pnpm check`.
