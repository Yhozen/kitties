---
name: test-behaviour
description: Pick the test shape that proves a behaviour. Use when you ask "how do I test this?", add a test, test a domain rule, a lifecycle, a retry, a session, a UI interaction, a timer, or a race, or review a test that might be tautological.
plain: "Name what the test proves, pick the shape for it, then plant a bug and watch the test fail."
diagram: |-
  what does it prove?
  ├ domain rule  → it.prop
  ├ history      → model test
  ├ UI behaviour → Scene
  └ one seam     → example
      │
  plant a bug → test fails
  restore     → test passes
---
> Kitties integration: follow the root `AGENTS.md` and `docs/TESTING.md`. Use
> `pnpm check`, `pnpm test`, and `pnpm build`. Ratstack-only paths and commands
> below describe upstream examples, not this repository. Verify Effect APIs
> against our installed guide. Source and adaptations: `../UPSTREAM.md`.


# Test a behaviour

A test proves one behaviour. Name that behaviour before you write the test. Then pick the shape below that fits it.

Each shape returns a fixed, independent answer. A test that reruns the code under test cannot catch its mistakes. Read [tests that earn their place](https://ratstack.sh/lore/tests-that-earn-their-place) first.

## 1. A domain rule: a property

A rule that holds for many inputs is an `it.prop` over Effect `Arbitrary` inputs. Use `it.effect.prop` when the check returns an Effect.

The core suite generates names and checks their length after trimming. The assertion states the accepted length without calling the validator:

[Pinned example](https://github.com/joelhooks/rat-stack/blob/f1e24f7ee9f9b5f4a06574cb8c1646de001e4a3f/packages/core/test/join-identity.test.ts)

```ts
it.effect.prop(
  "names trim before the nonempty 100-character bound",
  { input: Arbitrary.schema(Schema.String) },
  ({ input }) =>
    Effect.gen(function* names() {
      const trimmed = input.trim();

      const exit = yield* Schema.decodeEffect(ApplicantName)(input).pipe(
        Effect.exit
      );

      expect(Exit.isSuccess(exit)).toBe(
        trimmed.length > 0 && trimmed.length <= 100
      );

      if (Exit.isSuccess(exit)) {
        expect(exit.value).toBe(trimmed);
      }
    })
);
```

Read [property-based testing](https://ratstack.sh/lore/property-based-testing).

## 2. Anything with history: a model

Sessions, retries, and lifecycles depend on earlier steps. Generate command sequences and check the real system against a small model after each step.

The inspection lifecycle replays generated histories against the real actor:

[Pinned example](https://github.com/joelhooks/rat-stack/blob/1d4d3252326a216909ccec05e93312d1ab0eaf84/packages/core/test/inspect-machine.model.test.ts)

```ts
  it.effect.prop(
    "real actor preserves generated input, typed outcomes and terminal immutability",
    { generated: commands, scenario: Scenario },
    ({ generated, scenario }) => replayActor(scenario, generated),
    { arbitrary: { runs: 200 } }
  );
```

Copy [the upstream lifecycle model example](references/lifecycle.model.test.md) for a new machine. Read [model-based testing](https://ratstack.sh/lore/model-based-testing).

## 3. UI behaviour: a Foldkit Scene

A Scene runs `update`, the view, and subscriptions together. Input and time are data:

- Input is a step: `pointerDown`, `click`, `type`, or `Subscription.emit`.
- Time is a Command. Resolve it with `Command.resolve(WaitX, CompletedWaitX(...))`.
- Do not use fake timers, a clock, or a DOM.

A race is a plain assertion. Resolve a stale timer after the state has moved on, then assert that nothing broke.

Assert on what the view shows: roles, text, and data attributes. Do not assert on Model fields.

The reader's copy button resolves the copy and then its reset wait:

[Pinned example](https://github.com/joelhooks/rat-stack/blob/1d4d3252326a216909ccec05e93312d1ab0eaf84/apps/web/test/reader.scene.test.ts)

```ts
it("a copy confirms with text the reader can see and hear, then resets after the wait", () => {
  scene(
    { update, view },
    given(clipboardReady),
    click(copyButton),
    Command.expectExact(CopyReaderText({ id, text: promptText })),
    Command.resolve(CopyReaderText, Message.SucceededCopyReaderText({ id })),
    expect(role("status")).toHaveText("Copied ✓"),
    expect(copyButton).toContainText("Copied ✓"),
    Command.expectExact(WaitBeforeCopyReset({ id })),
    Command.resolve(
      WaitBeforeCopyReset,
      Message.CompletedWaitBeforeCopyReset({ id })
    ),
    expect(role("status")).toHaveText(""),
    expect(copyButton).toContainText(label),
    Command.expectNone()
  );
});
```

Read [UI behaviour is a scene](https://ratstack.sh/lore/ui-behaviour-is-a-scene) for the Foldkit UI Toast race.

## 4. A seam: one example

An example test fits one interface between parts, such as a service over the real filesystem. Keep one, and supply services through a Layer:

[Pinned example](https://github.com/joelhooks/rat-stack/blob/1d4d3252326a216909ccec05e93312d1ab0eaf84/packages/core/test/file-inspector.test.ts)

```ts
it.layer(TestLayer)("FileInspector", (test) => {
  test.effect("reads a file through the Effect filesystem", () =>
    Effect.gen(function* readsThroughFileSystem() {
      const file = yield* writeTempFile("notes.txt", "one two\nthree\n");
      const inspector = yield* FileInspector;

      const stats = yield* inspector.inspect(file);

      expect(stats).toMatchObject({ bytes: 14, lines: 2, words: 3 });
    })
  );
```

## 5. Always: plant a bug

1. Break the behaviour the test protects.
2. Run the test. It must fail.
3. Restore the code. The test must pass.

Reject these tests:

- A tautological test computes its expected answer with the code under test.
- A change-detector test fails on any edit and proves no rule.
- A regression test for a bug the suite already covers adds nothing.

Do not rewrite an expected result to match broken code.
