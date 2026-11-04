# Framework reference source

`foldkit/` is a read-only git subtree of
[foldkit/foldkit](https://github.com/foldkit/foldkit), pinned to release
`foldkit@0.170.0`, commit `a471adb24d750ab9e8d8312edad53ff6f26d961b`.
Its MIT license is retained at `foldkit/LICENSE`.

This follows [Foldkit's official agent setup](https://foldkit.dev/ai/overview).
The source, examples and upstream tests help agents understand the exact APIs
installed in `apps/web`. Kitties imports the published npm packages. This
directory is outside pnpm workspace membership, test discovery, coverage,
formatting and linting; its tests are reference material, not our suite.

Preserve the subtree tracking commits when merging imports and upgrades: use a
merge commit rather than squashing the pull request. The full-history secret
scan includes the imported root. Exact reviewed test-fixture fingerprints are
documented in `.gitleaksignore`; the reference directory is not exempted.

When upgrading Foldkit, update the package family together, then run:

```sh
git subtree pull --prefix=repos/foldkit https://github.com/foldkit/foldkit.git 'foldkit@<version>' --squash
cp repos/foldkit/packages/create-foldkit-app/templates/base/FOLDKIT.md FOLDKIT.md
```

Refresh the three copies in `.agents/skills/{foldkit,generate-program,audit-program}`
from the matching directories in `repos/foldkit/skills/`, retaining their guides
and `agents/openai.yaml` metadata. Update this revision and
`.agents/skills/UPSTREAM.md`, then run the checks in `AGENTS.md`.

The subtree includes its own repository instructions. Those describe development
of Foldkit itself. The root Kitties `AGENTS.md` governs this application.
