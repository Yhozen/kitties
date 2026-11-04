# Installed agent skills

These project-local skills are available to Codex and compatible agents from
`.agents/skills/`. The root `AGENTS.md` explains their use in Kitties.

## Foldkit

Source: https://github.com/foldkit/foldkit

Release: `foldkit@0.170.0`

Revision: `a471adb24d750ab9e8d8312edad53ff6f26d961b`

Skills: `foldkit`, `generate-program`, `audit-program`.

The skills and supporting guides originate from `skills/` at that release.
License: `LICENSE-foldkit` (MIT). Local adaptations:

- Foldkit is consumed from npm. Instructions to import a framework subtree are
  removed, and example references use the pinned upstream revision online.
- API signatures come from the installed declarations in
  `apps/web/node_modules/foldkit/` and `apps/web/node_modules/@foldkit/ui/`.
- Generation uses the existing Vite+ app and root tooling. It does not run a
  scaffolder over the workspace. Root `FOLDKIT.md` is adapted from the matching
  scaffold under the same policy.
- OpenAI display metadata is unchanged; upstream `argument-hint` fields live
  under the supported `metadata` frontmatter key. The user and root `AGENTS.md`
  govern task scope and approvals.

Canonical examples: https://github.com/foldkit/foldkit/tree/a471adb24d750ab9e8d8312edad53ff6f26d961b/examples

On upgrades, refresh the skills and guide from the matching release online,
update these pins and the example URLs, and retain these local adaptations.
No framework source, examples or upstream test suites are part of this repo.

## Ratstack

Source: https://github.com/joelhooks/rat-stack

Revision: `2a22d184d5578b79b0cf5852eea37ca1302ed380`

Skills: `uncomplect`, `durability`, `investigate-a-failure`, `learn-alchemy`,
`test-behaviour`. License: `LICENSE-rat-stack` (MIT).

Local adaptations:

- Each skill starts with a Kitties integration note pointing to our instructions
  and Vite+ commands. Ratstack examples do not install its scaffold or packages.
- Upstream `plain` and `diagram` fields live under the supported `metadata`
  frontmatter key, retaining their values.
- Website-relative links resolve to `https://ratstack.sh/`.
- The upstream site's six empty source-snippet placeholders are expanded from
  their declared source commits and line selections, with links to those pins.
- Failure investigation includes its four referenced principle documents under
  `references/`, along with upstream `LICENSE-pstack` attribution.
- Testing includes the referenced lifecycle model template under `references/`.
  It is an example for a matching lifecycle, not a requirement to adopt XState.

Skills were installed using the skill-installer helper with explicit repository
and revision arguments. To refresh, review upstream changes and retain these
adaptations. Never overwrite root project instructions from a scaffold.

Test tooling is explicitly authorized. The previous no-tests policy is
superseded; use `docs/TESTING.md` and keep tests focused on meaningful behavior.
