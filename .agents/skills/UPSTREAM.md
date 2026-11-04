# Installed agent skills

These project-local skills are available to Codex and compatible agents from
`.agents/skills/`. The root `AGENTS.md` explains their use in Kitties.

## Foldkit

Source: https://github.com/foldkit/foldkit

Release: `foldkit@0.170.0`

Revision: `a471adb24d750ab9e8d8312edad53ff6f26d961b`

Skills: `foldkit`, `generate-program`, `audit-program`.

The skill directories, supporting Markdown guides and OpenAI display metadata
are copied unchanged from `skills/` at that release. License: `LICENSE-foldkit`
(MIT). The canonical source and examples are available in `repos/foldkit/`.
Resolve upstream example paths there rather than relative to `.agents/`.

## Ratstack

Source: https://github.com/joelhooks/rat-stack

Revision: `2a22d184d5578b79b0cf5852eea37ca1302ed380`

Skills: `uncomplect`, `durability`, `investigate-a-failure`, `learn-alchemy`,
`test-behaviour`. License: `LICENSE-rat-stack` (MIT).

Local adaptations:

- Each skill starts with a Kitties integration note pointing to our instructions
  and Vite+ commands. Ratstack examples do not install its scaffold or packages.
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
