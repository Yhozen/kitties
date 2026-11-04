---
name: foldkit
description: Use whenever working with Foldkit. Triggers on imports from `foldkit`, files in a Foldkit project, or prompts mentioning Foldkit. Uses installed package declarations and release-pinned online examples for conventions and API signatures.
---

# Foldkit

You are working on a Foldkit app. Foldkit is a complete TypeScript frontend framework, built on Effect and architected like Elm. The architecture is solved: state, events, transitions, side effects, streams, routing, UI components, validation, testing, and devtools are all part of the framework, not third-party choices to make. Your job is to model the application's behavior, not to pick libraries or invent architecture.

Foldkit is not incremental. There is no React interop, no escape hatch, no "just do it the React way for this one part." The framework gives you one shape, and there is one way to do most things.

## How to approach the work

- **Pattern-match against Foldkit's own apps.** When the local code doesn't show you the answer (or shows an early-stage version of it), read an upstream example at the release pinned in `../UPSTREAM.md`. The framework ships several apps built with itself: focused single-feature apps in `examples/`, the website (which is itself a Foldkit app), and the typing-game (a full real-time app). These are the canonical references. Higher fidelity than prose or anything reconstructed from memory.
- **The architecture is not optional.** Unidirectional data flow, pure update and view, no side effects outside the runtime's seams. Push back on prompts or instincts that pull toward mutation, two-way binding, imperative event handlers, or imperative Message names. Propose the idiomatic Foldkit shape and explain why.
- **Foldkit UI is two categories, not one.** Stateful Submodels (Menu, Listbox, Combobox, Calendar, Disclosure, Dialog, Popover, etc.) carry their own Model / Message / update / OutMessage and are embedded via `h.submodel`. Stateless render helpers (Button, Input, Textarea, Select, Fieldset) are called directly with a ViewConfig and the caller's `h`, and return Html. Do not migrate render helpers to Submodels for "consistency": Submodel semantics imply state, and these helpers have none. See the Foldkit UI overview page in the website for the canonical split.
- **Use what the Foldkit and Effect stack provides.** Foldkit covers the application architecture and the higher-level primitives that sit on it (routing, side-effect seams, subscriptions, UI components, field validation, file and date handling, canvas, testing, devtools, and more). Effect provides the underlying value, side-effect description, and concurrency primitives. Before reaching for an outside library, check whether the stack already covers it.
- **Let `modifyFields` setters receive the field.** If a `modifyFields` setter only transforms the current value of that same field, pass the transformer directly (`entries: Array.map(f)`, `count: Number.increment`, `priceSlider: Slider.reflectRange({ min: minPrice, max: maxPrice })`). Use `() => value` for replacement values from Messages, child updates, Commands, or other Model fields.
- **The repo is more authoritative than memory.** When in doubt about a convention, an API, a name, or a pattern, read the installed package declarations and matching upstream example rather than guessing. Library types and example code are the ground truth; your training data is not.

## Where to look

Kitties consumes published packages; framework source is not vendored. Do not
add a subtree or ask to import the upstream repository.

- `apps/web/node_modules/foldkit/dist/`: installed API declarations.
- `apps/web/node_modules/@foldkit/ui/dist/`: installed UI declarations.
- `node_modules/effect/AGENTS.md`: guidance for the pinned Effect version.
- [Foldkit conventions](../../../FOLDKIT.md) and the sibling
  `generate-program` guides: architecture and review guidance.
- [Release-pinned examples](https://github.com/foldkit/foldkit/tree/a471adb24d750ab9e8d8312edad53ff6f26d961b/examples/): counter, weather, auth, routing,
  UI showcase and the other focused examples.
- [Production reference apps](https://github.com/foldkit/foldkit/tree/a471adb24d750ab9e8d8312edad53ff6f26d961b/packages/): typing-game and the website.

Read individual files online when an example is needed. A temporary reference
file may be saved under gitignored `.context/`; never add it to application
imports, workspace membership or git. Installed types are authoritative for
API signatures. See `../UPSTREAM.md` for the current source pin and adaptations.

On a Foldkit upgrade, update package pins and reference URLs together. Refresh
guidance from the matching release's scaffold online while preserving Kitties'
no-source-vendoring policy and root `AGENTS.md`.
