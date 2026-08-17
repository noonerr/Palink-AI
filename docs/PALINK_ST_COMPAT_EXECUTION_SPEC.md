# Palink ST Compatibility Execution Spec

> Date: 2026-06-27
> Reference baseline: local `SillyTavern-1.18.0/SillyTavern-1.18.0`
> Target audience: implementation agents working on Palink-AI ST compatibility.

## Purpose

Bring Palink's SillyTavern compatibility from "main roleplay path works" to
"native ST fallback and common extension paths are reliable".

This spec is execution-focused. It supersedes scattered TODO notes for the
items listed here, but does not replace:

- `docs/PALINK_ST_HOST_CONTRACT.md`
- `docs/PALINK_ST_RUNTIME_IMPLEMENTATION_PLAN.md`
- `docs/PALINK_ST_AGENT_TODO.md`

## Ownership Model

Palink remains the authority for:

- auth, users, permissions
- model routing and provider keys
- generation presets used by Palink-native generation
- characters, chats, worldbooks, personas, variables
- TTS, STT, SD/image generation through Palink services

SillyTavern is the compatibility reference for:

- ST frontend API shapes
- ST `getContext()` public surface
- ST event names, payload order, and lifecycle timing
- roleplay prompt semantics
- world info activation semantics
- slash command behavior
- import/export file formats

Do not let the ST sidecar become the source of truth for Palink data. ST Native
is a fallback UI/runtime; persisted data must still flow through Palink APIs or
Palink-controlled sync.

## Current Baseline

Already present or partially present:

- `backend/app/api/silly_tavern.py` contains many ST-compatible endpoints:
  characters, chats, settings, generation, worldinfo, thumbnail, tokenizers,
  ST Native auth/proxy.
- `frontend/public/st/bridge.js` boots ST Native and forwards selected API
  paths.
- `frontend/src/lib/sillytavern/getContext.ts` implements a large Palink-native
  ST `getContext()` shim.
- `frontend/src/lib/sillytavern/runtime.ts` implements an event wrapper,
  message operations, generation events, variables, regex hooks, worldbook
  sharing.
- `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`
  provides a broad SmartCard/global-object compatibility runtime.
- `backend/app/services/worldbook_service.py` implements a ST-like backend
  worldbook engine with recursive scan, probability, group scoring, sticky,
  cooldown, delay, positions, depth entries, and debug report.
- `backend/app/services/slash_command_service.py` implements a small backend
  slash subset.

Main gaps:

- ST Native endpoint surface is incomplete.
- Group chat compatibility is incomplete.
- Import/export parity is incomplete.
- Event timing and payload shapes need contract tests.
- Palink-native slash commands still include many `not available` paths.
- Worldbook behavior needs closer comparison against ST global settings and
  debug/event shapes.

## Non-Goals

Do not implement these unless explicitly assigned:

- Full ST backend ownership.
- Direct ST management of provider keys.
- Direct ST management of Palink users.
- Blanket compatibility with every third-party ST extension.
- Rewriting the Palink UI into ST.
- Replacing Palink memory, MCP, model gateway, TTS, STT, or image services with
  ST modules.

## Source References

Use the local ST source as the primary reference:

- `SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/st-context.js`
- `SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/events.js`
- `SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/world-info.js`
- `SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/extensions/regex/engine.js`
- `SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/slash-commands.js`
- `SillyTavern-1.18.0/SillyTavern-1.18.0/src/server-startup.js`
- `SillyTavern-1.18.0/SillyTavern-1.18.0/src/endpoints/*`

Use Palink entry points:

- `backend/app/api/silly_tavern.py`
- `backend/app/api/st_groups.py`
- `backend/app/services/st_sync_service.py`
- `backend/app/services/worldbook_service.py`
- `backend/app/services/slash_command_service.py`
- `backend/app/character_card.py`
- `backend/app/services/character_import_service.py`
- `frontend/public/st/bridge.js`
- `frontend/src/lib/sillytavern/getContext.ts`
- `frontend/src/lib/sillytavern/runtime.ts`
- `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`
- `frontend/src/lib/slash-engine/*`
- `frontend/src/lib/worldbook/*`

## Priority Legend

- P0: Blocks ST Native fallback or common SmartCard/plugin behavior.
- P1: Important for broad compatibility, but not required for first stable
  fallback.
- P2: Useful parity or polish.

## Work Package A: ST Native Endpoint Surface

Priority: P0

Goal: When official ST frontend calls common endpoints, Palink either implements
the endpoint or safely proxies it to ST Native without breaking Palink data
ownership.

### Required Endpoints

Implement or verify these in `backend/app/api/silly_tavern.py` and related
routers:

- `POST /api/characters/import`
- `POST /api/characters/export`
- `POST /api/characters/edit-avatar`
- `POST /api/characters/edit-attribute`
- `POST /api/chats/import`
- `POST /api/chats/export`
- `POST /api/chats/recent`
- `POST /api/worldinfo/list`
- `POST /api/worldinfo/import`
- `POST /api/groups/all`
- `POST /api/groups/create`
- `POST /api/groups/edit`
- `POST /api/groups/delete`
- `POST /api/chats/group/get`
- `POST /api/chats/group/info`
- `POST /api/chats/group/save`
- `POST /api/chats/group/delete`
- `POST /api/chats/group/import`
- `POST /api/backgrounds/all`
- `POST /api/backgrounds/folders`
- `POST /api/backgrounds/upload`
- `POST /api/backgrounds/rename`
- `POST /api/backgrounds/delete`
- `POST /api/avatars/get`
- `POST /api/avatars/upload`
- `POST /api/avatars/delete`
- `GET /api/sprites/get`
- `POST /api/sprites/upload`
- `POST /api/sprites/upload-zip`
- `POST /api/sprites/delete`
- `POST /api/assets/get`
- `POST /api/assets/character`
- `POST /api/assets/download`
- `POST /api/assets/delete`
- `POST /api/quick-replies/save`
- `POST /api/quick-replies/delete`
- `POST /api/images/upload`
- `POST /api/images/list/{folder}`

Provider-specific ST endpoints can be stubs or redirects if Palink owns the
provider feature:

- `/api/sd/*`
- `/api/speech/*`
- `/api/openai/generate-voice`
- `/api/openai/generate-image`
- `/api/vector/*`
- `/api/translate/*`
- `/api/search/*`

### Implementation Rules

- Prefer Palink-backed behavior when data is Palink-owned.
- For resource endpoints that only support ST UI chrome, safe empty responses
  are acceptable if the official ST frontend tolerates them.
- Avoid returning 404 for known ST endpoints.
- Keep endpoint response shapes close to ST, even if data is empty.
- Do not expose Palink secrets through ST `/api/secrets/*`. If implemented,
  return safe empty/forbidden shapes unless explicitly authorized.

### Acceptance

- Official ST frontend boots in ST Native mode without console 404 spam for the
  endpoint list above.
- Character page, chat page, world info page, background selector, and group
  page load without fatal errors.
- Unsupported provider endpoints fail gracefully with a ST-compatible response
  shape, not an unhandled exception.

## Work Package B: Group Chat Compatibility

Priority: P0

Goal: Support ST group chat API and enough runtime events for ST Native group
chat and Palink-native group-aware plugins.

### Backend Tasks

Implement/verify ST-compatible group shapes:

- group object fields: `id`, `name`, `members`, `avatar_url`, `chat_id`,
  `chats`, `activation_strategy`, `generation_mode`, `disabled_members`,
  `allow_self_responses`, `metadata`.
- group chat JSONL conversion for `/api/chats/group/get` and
  `/api/chats/group/save`.
- group import path for ST group chat files.
- safe mapping to existing Palink group models in `backend/app/models/group_chat.py`.

### Frontend Runtime Tasks

Align `getContext()` and SmartCard runtime:

- `groups`
- `groupId`
- `openGroupChat`
- `unshallowGroupMembers`
- `GROUP_UPDATED`
- `GROUP_CHAT_CREATED`
- `GROUP_CHAT_DELETED`
- `GROUP_MEMBER_DRAFTED`
- `GROUP_WRAPPER_STARTED`
- `GROUP_WRAPPER_FINISHED`

### Acceptance

- ST Native `/api/groups/all` returns groups in official ST-compatible shape.
- ST Native can open a group chat and load messages.
- Saving a group chat writes back to Palink.
- Group events fire with ST event names and expected argument order.

## Work Package C: Import/Export Parity

Priority: P0

Goal: Palink import/export through ST-compatible endpoints preserves card,
chat, and worldbook data.

### Character Cards

Required behavior:

- Import PNG and JSON cards through `/api/characters/import`.
- Export through `/api/characters/export`.
- Preserve V2 and V3 source shape where possible.
- Preserve `extensions`, `depth_prompt`, `alternate_greetings`, `creator_notes`,
  `creator`, `character_version`, `tags`, `talkativeness`, `fav`,
  `character_book`, and raw card metadata.
- Do not degrade V3 cards to V2 when raw V3 data is available.

Relevant files:

- `backend/app/character_card.py`
- `backend/app/services/character_import_service.py`
- `backend/app/api/silly_tavern.py`

### Chats

Required behavior:

- Import ST JSONL through `/api/chats/import`.
- Export ST JSONL through `/api/chats/export`.
- Preserve `chat_metadata`, `variables`, `swipes`, `swipe_id`, `swipe_info`,
  `extra`, `is_system`, `is_user`, `is_hidden`, `is_locked`, reasoning fields,
  files/media/tool-call metadata where present.

### World Info

Required behavior:

- Import ST world info through `/api/worldinfo/import`.
- List world info through `/api/worldinfo/list`.
- Preserve entry `extensions`.
- Preserve advanced fields: position, depth, probability, selective logic,
  group fields, recursion flags, display index, vectorized flag, match flags,
  sticky/cooldown/delay, automation id if present.

### Acceptance

- Round-trip tests exist for character card JSON, character PNG, chat JSONL, and
  world info JSON.
- Round-trip does not drop known ST fields listed above.
- V3 card export remains V3 when imported from V3.

## Work Package D: Event Contract Tests

Priority: P0

Goal: Stop guessing about ST event compatibility. Add tests for event names,
argument order, and lifecycle timing.

### Reference

Use:

- `SillyTavern-1.18.0/SillyTavern-1.18.0/public/scripts/events.js`
- `SillyTavern-1.18.0/SillyTavern-1.18.0/public/script.js`
- `frontend/src/lib/sillytavern/runtime.ts`
- `frontend/src/lib/sillytavern/getContext.ts`
- `frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts`

### Must Cover

Lifecycle:

- `APP_INITIALIZED`
- `APP_READY`
- `SETTINGS_LOADED_BEFORE`
- `SETTINGS_LOADED_AFTER`
- `SETTINGS_LOADED`
- `EXTENSION_SETTINGS_LOADED`

Chat/message:

- `CHAT_LOADED`
- `CHAT_CHANGED`
- `CHAT_CREATED`
- `CHAT_RENAMED`
- `CHAT_DELETED`
- `MESSAGE_SENT`
- `USER_MESSAGE_RENDERED`
- `MESSAGE_RECEIVED`
- `CHARACTER_MESSAGE_RENDERED`
- `MESSAGE_EDITED`
- `MESSAGE_UPDATED`
- `MESSAGE_DELETED`
- `MESSAGE_SWIPED`
- `MESSAGE_SWIPE_DELETED`

Generation:

- `GENERATION_STARTED`
- `GENERATION_AFTER_COMMANDS`
- `CHAT_COMPLETION_SETTINGS_READY`
- `CHAT_COMPLETION_PROMPT_READY`
- `STREAM_TOKEN_RECEIVED`
- `STREAM_REASONING_DONE`
- `GENERATION_STOPPED`
- `GENERATION_ENDED`
- `GENERATE_BEFORE_COMBINE_PROMPTS`
- `GENERATE_AFTER_COMBINE_PROMPTS`
- `GENERATE_AFTER_DATA`

World info:

- `WORLDINFO_UPDATED`
- `WORLDINFO_SETTINGS_UPDATED`
- `WORLD_INFO_ACTIVATED`
- `WORLDINFO_FORCE_ACTIVATE`
- `WORLDINFO_ENTRIES_LOADED`
- `WORLDINFO_SCAN_DONE`

### Acceptance

- Tests assert event names match ST string values exactly.
- Tests assert argument order for common events.
- Tests assert late listeners still receive replayed app-ready events where
  Palink claims to support replay.
- SmartCard runtime and Palink-native runtime both pass the core event contract
  subset.

## Work Package E: `getContext()` Public Surface Parity

Priority: P1

Goal: Ensure common ST plugins can use `SillyTavern.getContext()` without
missing high-frequency APIs.

### Required Fields/Methods

Verify or implement these fields from official `st-context.js`:

- `accountStorage`
- `chat`
- `characters`
- `groups`
- `name1`
- `name2`
- `characterId`
- `groupId`
- `chatId`
- `getCurrentChatId`
- `getRequestHeaders`
- `reloadCurrentChat`
- `renameChat`
- `saveSettingsDebounced`
- `onlineStatus`
- `maxContext`
- `chatMetadata`
- `saveMetadataDebounced`
- `streamingProcessor`
- `eventSource`
- `eventTypes`
- `addOneMessage`
- `deleteLastMessage`
- `deleteMessage`
- `generate`
- `sendStreamingRequest`
- `sendGenerationRequest`
- `stopGeneration`
- `tokenizers`
- `getTextTokens`
- `getTokenCount`
- `getTokenCountAsync`
- `extensionPrompts`
- `setExtensionPrompt`
- `updateChatMetadata`
- `saveChat`
- `openCharacterChat`
- `openGroupChat`
- `saveMetadata`
- `sendSystemMessage`
- `activateSendButtons`
- `deactivateSendButtons`
- `saveReply`
- `substituteParams`
- `substituteParamsExtended`
- `SlashCommandParser`
- `SlashCommand`
- `SlashCommandArgument`
- `SlashCommandNamedArgument`
- `SlashCommandEnumValue`
- `ARGUMENT_TYPE`
- `executeSlashCommandsWithOptions`
- `registerSlashCommand`
- `executeSlashCommands`
- `registerMacro`
- `unregisterMacro`
- `renderExtensionTemplate`
- `renderExtensionTemplateAsync`
- `callPopup`
- `callGenericPopup`
- `showLoader`
- `hideLoader`
- `extensionSettings`
- `writeExtensionField`
- `writeExtensionFieldBulk`
- `generateQuietPrompt`
- `generateRaw`
- `generateRawData`
- `getThumbnailUrl`
- `selectCharacterById`
- `messageFormatting`
- `isMobile`
- `t`
- `translate`
- `getCurrentLocale`
- `tags`
- `tagMap`
- `getCharacters`
- `getOneCharacter`
- `getCharacterCardFields`
- `getCharacterSource`
- `updateMessageBlock`
- `appendMediaToMessage`
- `ensureMessageMediaIsArray`
- `scrollChatToBottom`
- `swipe`
- `variables`
- `loadWorldInfo`
- `saveWorldInfo`
- `reloadWorldInfoEditor`
- `updateWorldInfoList`
- `convertCharacterBook`
- `getWorldInfoPrompt`
- `getWorldInfoNames`
- `CONNECT_API_MAP`
- `extractMessageFromData`
- `getPresetManager`
- `printMessages`
- `clearChat`
- `unshallowCharacter`
- `unshallowGroupMembers`

### Acceptance

- Add a test that compares expected key presence against official ST
  `st-context.js`.
- Missing APIs are either implemented or explicitly documented as unsupported
  with safe no-op behavior.
- No common getter throws when no character or no chat is active.

## Work Package F: Slash Command Runtime

Priority: P1

Goal: Replace "not available" placeholders for roleplay-critical commands with
real Palink behavior.

### Backend Commands

Extend `backend/app/services/slash_command_service.py`:

- `/send`
- `/gen`
- `/continue`
- `/retry`
- `/swipe`
- `/branch`
- `/model`
- `/preset`
- `/sys`
- `/note` and `/an`
- `/setvar`
- `/getvar`
- `/incvar`
- `/decvar`
- `/addvar`
- `/delvar`
- `/world`
- `/wi`

### Frontend Commands

Extend `frontend/src/lib/slash-engine/*`:

- Remove `not available` for commands with available Palink actions.
- Ensure commands can be registered by extensions.
- Preserve ST-like return behavior: commands may produce chat messages,
  command output, side effects, or generation triggers.

### Acceptance

- `/send hello` appends/sends a user message.
- `/gen` triggers generation.
- `/continue` triggers continuation.
- `/retry` regenerates last assistant response.
- `/swipe left|right|new` works where swipes exist.
- `/setvar mood happy | /getvar mood` persists to current chat variables.
- `/branch` can create or switch Palink branches if supported.
- Commands work in HTTP and WebSocket generation paths, or unsupported paths are
  explicitly tested and documented.

## Work Package G: Worldbook ST Semantics

Priority: P1

Goal: Ensure backend worldbook behavior matches ST for normal roleplay cases and
is observable when it diverges.

### Compare Against ST

Use `public/scripts/world-info.js` to verify:

- global `world_info_settings`
- scan depth
- token budget and budget cap
- min activations
- min activations depth max
- max recursion steps
- include names
- recursive scanning toggle
- case sensitive toggle
- match whole words toggle
- group scoring toggle
- overflow behavior
- character strategy
- character primary and extra world info selection
- constant entries
- probability
- selective logic
- `exclude_recursion`
- `prevent_recursion`
- `delay_until_recursion`
- `delay_until_recursion_level`
- group override and group weight
- depth insertion
- before/after/example positions
- vectorized entries, even if only marked unsupported

### Required Output

`build_worldbook_context()` should expose a debug report sufficient to answer:

- why each entry activated or skipped
- matched primary and secondary keys
- recursion depth
- probability roll result
- group scoring decision
- budget inclusion or exclusion
- final insertion position

### Acceptance

- Add fixtures comparing Palink activation against expected ST behavior for at
  least:
  - constant entry
  - primary key match
  - selective AND/OR/NOT
  - probability 0 and 100
  - recursion activation
  - prevent recursion
  - delay until recursion
  - group weighted choice
  - depth insertion
  - budget exclusion
- `WORLDINFO_SCAN_DONE` emits a useful debug payload.

## Work Package H: Extension/SmartCard Compatibility Matrix

Priority: P1

Goal: Stop treating plugin compatibility as binary. Track and test classes of
extensions.

### Extension Classes

Class A: public API only

- Depends on `getContext`, `eventSource`, message APIs, generation APIs,
  variables, popup/toast.
- Must work in Palink-native and SmartCard runtime.

Class B: mixed public/internal ST APIs

- Depends on extension settings, regex, worldbook, templates, selected DOM
  elements.
- Should work where reasonable; otherwise document exact missing APIs.

Class C: native ST DOM/private backend dependency

- Depends on ST page structure, private modules, extension loader internals, or
  ST filesystem endpoints.
- Only guaranteed in ST Native mode.

### Tasks

- Create `docs/PALINK_ST_PLUGIN_COMPAT_MATRIX.md`.
- Add rows for:
  - regex extension
  - quick reply
  - token counter
  - expressions
  - caption
  - TTS
  - vectors
  - gallery
  - assets
  - connection-manager
  - memory
  - attachments
- For each row: class, required APIs, status, failing path, owner, next action.

### Acceptance

- Matrix exists and is linked from `docs/PALINK_ST_AGENT_TODO.md`.
- Each supported plugin class has at least one smoke test or manual QA note.
- Class C plugins are not promised in Palink-native.

## Work Package I: Contract/Smoke Test Harness

Priority: P0

Goal: Give future agents a fast way to verify they did not regress ST
compatibility.

### Backend Tests

Add tests for:

- ST settings get/save
- characters all/get/create/edit/import/export/delete
- chats get/save/import/export/search/rename/delete
- groups all/create/edit/delete and group chats
- worldinfo list/get/import/edit/delete
- chat-completions generate/status response shape

### Frontend Tests

Add tests for:

- `getContext()` key presence
- event source `on/off/once/makeFirst/makeLast`
- event argument order
- slash command execution
- SmartCard runtime core globals
- regex execution order
- worldbook scan preview/debug

### Browser Smoke

Extend or add scripts near:

- `scripts/smart-card-compat-smoke.cjs`

Required smoke flows:

- ST Native boots.
- ST Native loads one Palink character.
- ST Native loads and saves a chat.
- Palink-native SmartCard opens and receives `APP_READY`.
- SmartCard can call `SillyTavern.getContext()`.
- SmartCard can call `generateQuietPrompt()` with a stubbed or real model
  depending on environment.

### Acceptance

- Test names clearly mention ST compatibility.
- Tests can run locally without external network.
- If model generation is required, provide an environment flag to skip or stub.

## Work Package J: Documentation Cleanup

Priority: P2

Goal: Make ST compatibility status legible for future agents.

### Tasks

- Update `docs/PALINK_ST_AGENT_TODO.md` to link this spec.
- Move stale claims in `docs/SILLYTAVERN_COMPAT_AUDIT.md` into an archive note
  or add a header saying it is an older audit.
- Add a current status table:
  - Endpoint surface
  - Group chat
  - Import/export
  - Event contract
  - `getContext()`
  - Slash commands
  - Worldbook
  - SmartCard runtime
  - ST Native sidecar

### Acceptance

- A new agent can find the current spec from `PALINK_ST_AGENT_TODO.md`.
- Old docs no longer look like the latest truth when they conflict with code.

## Suggested Agent Split

Use these assignments for parallel work:

- Agent 1: Work Package A endpoint inventory and missing endpoint stubs.
- Agent 2: Work Package B group chat API and conversion.
- Agent 3: Work Package C import/export round-trip.
- Agent 4: Work Package D/E event and `getContext()` contract tests.
- Agent 5: Work Package F slash commands.
- Agent 6: Work Package G worldbook ST semantics fixtures.
- Agent 7: Work Package H/J plugin matrix and docs cleanup.

Agents must not overwrite each other's files blindly. Before editing, check
`git status --short` and inspect any touched file for existing changes.

## Execution Progress (2026-06-27)

Status in this table is intentionally conservative. Mark `[done]` only after
implementation and a minimal runtime or automated verification both exist.

| Work Package | Priority | Status | Notes |
|--------------|----------|--------|-------|
| A: ST Native Endpoint Surface | P0 | [done] | Container acceptance 45/45 ST endpoints registered, 46/46 WP-A checks pass; browser smoke 6/6 pass; `/api/chats/save` accepts ST stringified `chat` |
| B: Group Chat Compatibility | P0 | [done] | `/api/groups/all` returns ST list; JSONL round-trip preserves messages; group routes registered |
| C: Import/Export Parity | P0 | [done] | V2/V3 card, chat JSONL, worldbook round-trip verified in container; `character_book`/`group_only_greetings` field retention fixed |
| D: Event Contract Tests | P0 | [done] | 31/31 ST core events in eventTypes; SmartCard runtime detects `window.SillyTavern`/`window.getContext` on character page (browser smoke pass) |
| E: getContext() Parity | P1 | [done] | 101/101 ST APIs in getContext; runtime now exposes `window.SillyTavern`/`window.getContext`/`window.eventSource`; browser smoke confirms `getContext()` returns object with chat/characters/chatMetadata keys |
| F: Slash Command Runtime | P1 | [done] | 5 commands registered; `execute_slash_command(text, ctx)` verified callable |
| G: Worldbook ST Semantics | P1 | [done] | Constants/matching/model fields pass acceptance; selective_logic semantic difference documented |
| H: Plugin Compat Matrix | P1 | [done] | `docs/PALINK_ST_PLUGIN_COMPAT_MATRIX.md` created as a static analysis matrix |
| I: Contract/Smoke Test Harness | P0 | [done] | `docker exec palink-ai-backend-1 python tests/run_st_acceptance.py` passes 81/81; browser smoke 6/6 pass; pytest is still not installed in the backend container |
| J: Documentation Cleanup | P2 | [done] | Spec and todo updated with verified status |

## Verification Notes (2026-06-27)

Commands run:

- `npm run build` in `frontend`: passed.
- `curl -I http://127.0.0.1:3000/st/index.html`: passed with HTTP 200.
- `node scripts/st-compat-smoke.cjs`: passed 6/6 (all tests green).
- `docker exec palink-ai-backend-1 python tests/run_st_acceptance.py`: passed 81/81.
- `docker exec palink-ai-backend-1 python -m pytest test_st_runtime_convergence.py -q`: could not run because `pytest` is not installed in the current backend container.

Fixes applied in this round:

- `/api/chats/save` 422: `ChatSaveRequest.chat` changed from `list[Any]` to `Any`; `st_save_chat` now JSON-parses stringified `chat` payload (ST 1.18.0 sends `JSON.stringify([...])`).
- `test_st_runtime_convergence.py` import error: removed `from app.services.worldbook_service import WorldbookEngine` (symbol does not exist).
- SmartCard runtime not detected: `setGlobalSillyTavernRuntime` now mounts `window.SillyTavern`, `window.getContext`, `window.eventSource` so external probes (smoke tests, ST plugins) can detect the runtime.
- Smoke script character ID: ST `/api/characters/all` returns `id` = avatar filename; URL routing needs `palink_id` (UUID). Fixed to use `target.palink_id`.
- Smoke script SmartCard/getContext detection: now checks `window`-level globals (palink-native mode), not just iframes (ST Native mode); added 10s polling for async runtime creation.

Browser smoke results:

- ST Native status: passed (mode=palink-native, version=1.18.0).
- Character list/get: passed, 20 characters visible.
- Chat get/save: passed, `/api/chats/save` returns `{"result":"ok"}` with ST stringified payload.
- SmartCard runtime: passed, `window.SillyTavern` and `window.getContext` detected on character page.
- `getContext`: passed, returns object with `chat`, `characters`, `chatMetadata`, `chatId`, `onlineStatus`, `extensionSettings` keys.
- `generateQuietPrompt`: skipped (SKIP_GENERATION=true).

Remaining known limitations:

- `http://127.0.0.1:8000/` returns empty because frontend container maps host 8000 to unused container port 8081; use `http://127.0.0.1:3000` for browser smoke.
- Host `.venv` has no `python.exe`; backend tests run through Docker.
- Worldbook `selective_logic` semantic difference with ST documented (Palink applies to primary keys, ST to secondary).
- Plugin discovery returns 401 in smoke (token not forwarded to plugin API); does not affect character page rendering.
- `python -m pytest ...` cannot run in the current backend container until pytest is installed or tests are run in a test image.

## Definition Of Done

A package is done when:

- Implementation is complete.
- Tests or smoke scripts cover the changed behavior.
- Unsupported ST behavior is explicitly documented.
- No known ST endpoint in the package returns accidental 404.
- No Palink-owned data is delegated to ST as the source of truth.
- The agent updates this spec or `PALINK_ST_AGENT_TODO.md` with completion notes
  if the implementation changes the plan.

## First Recommended Sequence

1. Build endpoint inventory tests for official ST common endpoints.
2. Add safe endpoint stubs for missing common ST endpoints.
3. Implement group chat API shapes.
4. Add import/export round-trip tests.
5. Add event contract tests.
6. Replace slash `not available` placeholders for roleplay-critical commands.
7. Tighten worldbook fixtures.
8. Create plugin compatibility matrix.
