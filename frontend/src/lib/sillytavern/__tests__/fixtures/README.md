# ST 1.18.0 slash-command fixture

`st-slash-commands-1.18.0.json` — ground-truth list of SillyTavern slash
commands extracted statically from the vendored reference source. Backs the
"how many of the 289 commands are covered" acceptance check that previously
lived only in report prose.

## Counts (ST 1.18.0, `_reference/sillytavern-1.18.0/public/scripts/`)

| bucket | count | meaning |
|---|---|---|
| `core` | 220 | commands from first-party non-extension scripts (power-user.js, chats.js, personas.js, backgrounds.js, …) |
| `extension` | 73 | commands from `extensions/**` + `extensions-slashcommands.js` (connection-manager, vectors, regex, sd, tts, quick-reply, …) |
| `commands` | 293 | unique command names = `core ∪ extension` (a name counted once even if both) |
| `aliases` | 176 | secondary names from `aliases: [...]` |

Narrative target from the main-control report was ≈222 core + 67 ext (+175 aliases ≈ 289).
Static extraction yields 220 / 73 (total 293). The ±few delta comes from
parser-internal names (`/`, `?`, `parser-flag`, `break`, `breakpoint`) that ARE
registered via `fromProps` and from where a name is classified core vs extension.
This fixture is the **re-runnable** authority; do not re-derive it by hand.

## How it was extracted (re-run after an upstream ST bump)

Script: `.tmp_probe/extract_st_commands_E1.py` (run `py .tmp_probe/extract_st_commands_E1.py --write`).

Method:
1. Walk every `.js` under the reference scripts dir.
2. Match command-registration idiom `(?<![\w.])SlashCommand\s*\.\s*from(Props|AsyncFunction|Function|RawFunction|Manual)\s*(`.
   The negative lookbehind excludes the ARGUMENT classes `SlashCommandNamedArgument`
   and `SlashCommandArgument` (their `.fromProps({name})` are parameters, not commands).
3. Brace/string-match the object, take the **first** `name: '…'` as the command name.
4. Collect `aliases: ['…', …]` from the same object.
5. Bucket by file path (extensions/ → extension, else core); dedupe; drop names that are only aliases.

NOT captured (and intentionally): `help`/`format`/`crop`/`wrap`/`countwords` are
Showdown macros / globals, not slash commands registered via `fromProps`.

## Verify coverage against the running runtime

The runtime proxy gotcha: `Object.keys(SlashCommandParser.commands)` is the truth
(`.keys()` returns the inner Map's 7 prototype keys, not commands). Compare the
runtime `Object.keys(...)` set against `commands` here; report missing = fixture − runtime.

## Relationship to `st289-names.json` (two fixtures, two jobs)

`frontend/src/lib/slash-engine/__tests__/fixtures/st289-names.json` is the **probe
denominator** (289 names, moved out of `.tmp_probe/st289.json` so the probe no longer
depends on a scratch directory). It is a strict subset of this fixture: the delta is
exactly the four parser-internal names `/`, `break`, `breakpoint`, `parser-flag`.
When the two disagree, **this file is the authority** — the seed list injected into the
frame (`frontend/src/lib/slash-engine/st-command-catalog.ts`) is guarded to equal the
`commands` array here by
`frontend/src/lib/slash-engine/__tests__/st-command-catalog-contract.test.ts`.
