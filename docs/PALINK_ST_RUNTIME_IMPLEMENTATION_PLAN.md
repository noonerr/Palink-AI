# Palink ST Runtime Implementation Plan

## Goal

Build a Palink-managed SillyTavern-compatible runtime while keeping Palink in
control of users, models, TTS, image generation, storage, and permissions.

The target is not to reimplement every SillyTavern screen. The target is to
reuse ST's proven roleplay runtime concepts where they matter: prompt assembly,
world info, macros, slash commands, variables, extension settings, events, and
plugin compatibility.

## Prompt Compatibility Principle

Palink owns prompt assembly, but the default roleplay prompt behavior should be
implemented to match SillyTavern semantics as closely as practical.

This means:

- `palink-native` is the only prompt runtime authority.
- prompt section ordering should follow ST-compatible roleplay behavior by
  default.
- character card fields, author note, worldbook, depth prompt, preset prompts,
  macros, regex, and slash-command side effects should be applied in an
  ST-compatible order unless there is a documented reason not to.
- Palink-specific features such as multi-user isolation, memory, permissions,
  model gateway routing, TTS, image generation, and MCP may extend the pipeline,
  but should not casually change roleplay prompt semantics.

Practical rule:

- Palink assembles the prompt.
- ST defines the reference behavior for roleplay compatibility.
- `st-native` remains the fallback reference runtime when compatibility is in
  doubt.

## Current Step

### Step 1: Unified Prompt Assembly

Status: started.

Implemented backend service:

- `backend/app/services/roleplay_prompt_assembly.py`

This service centralizes:

- base character system prompt
- author note
- smart-card start context
- worldbook context
- plotline context
- response length guidance
- memory context
- depth prompt insertion
- prompt regex pass
- debug assembly report

HTTP and WebSocket character chat now call this service and use its final
`messages`, `memory_mode`, and `effective_max_tokens`.

Remaining cleanup:

- remove old duplicated prompt-building blocks from `character_ext.py`
- remove old duplicated prompt-building blocks from `websocket.py`
- add a protected debug endpoint for prompt assembly inspection

## Phase 1: Prompt Runtime Foundation

Priority: P0.

1. Make `roleplay_prompt_assembly.py` the only source of truth.
2. Add structured `PromptAssemblyReport` persistence or debug endpoint.
3. Move compact-title instruction into an explicit prompt section.
4. Add deterministic ordering for all prompt sections.
5. Add token-budget accounting per section.
6. Add tests for:
   - normal character chat
   - smart-card trigger chat
   - worldbook injection
   - memory enabled/disabled
   - depth prompt insertion
   - prompt regex application
   - ST-compatible prompt ordering for roleplay

## Phase 2: ST-Grade Worldbook Engine

Priority: P0.

Replace the current keyword-only backend worldbook pass with ST-like behavior:

- recursive scanning
- scan depth per entry
- primary and secondary keys
- AND/OR/NOT selective logic
- probability
- ordering and priority
- token budget
- insertion position
- depth injection
- sticky, cooldown, delay
- character/global/session worldbook layering
- debug report showing why each entry activated or skipped

Implementation target:

- evolve `backend/app/services/worldbook_service.py`
- keep `frontend/src/lib/worldbook/*` as a reference, but backend must be the
  authority for generation.

## Phase 3: Macro And Variable Runtime

Priority: P0.

Palink currently has macro and variable modules, but they need to become part of
the backend prompt path.

Implement:

- persistent chat variables
- persistent user/global variables
- scoped variables for one generation
- ST macro parser behavior for common macros
- variable macros: get/set/add/inc/dec/delete/exists
- macro evaluation in:
  - character cards
  - author note
  - worldbook entries
  - preset prompts
  - extension prompts

Avoid regex-only macro parsing for complex nested macros.

## Phase 4: Slash Command Runtime

Priority: P0/P1.

The current slash engine has many commands that return `not available`.

Wire commands to real Palink actions:

- `/send`
- `/gen`
- `/continue`
- `/retry`
- `/swipe`
- `/branch`
- `/world`
- `/setvar`
- `/getvar`
- `/model`
- `/preset`

The command executor should run before prompt assembly and produce a structured
action result.

## Phase 5: Extension Runtime Contract

Priority: P1.

Turn compatibility stubs into a versioned runtime contract:

- event types
- event source
- extension settings
- plugin settings mount
- chat/message APIs
- worldbook APIs
- variable APIs
- slash command APIs
- popup/toast APIs

Track plugin compatibility with a matrix instead of trying to support every
plugin at once.

## Phase 6: Palink Tavern Frontend Distribution

Priority: P1.

Fork/customize ST frontend/runtime as a Palink-managed Tavern mode:

- Palink theme
- Palink navigation
- Palink auth/session
- hide ST provider/key management
- hide ST TTS/image provider management
- route generation through Palink OpenAI-compatible backend
- route TTS through Palink TTS backend
- route image generation through Palink image backend
- keep ST render/plugin/event/extension runtime

Do not delete large ST modules first. Disable, redirect, then remove only after
replacement APIs are stable.

## Phase 7: Multi-User Data Authority

Priority: P1.

Keep multi-user isolation in Palink.

Data authority:

- users: Palink
- auth/session: Palink
- providers/API keys: Palink
- generation presets: Palink, exported to ST shape when needed
- characters: Palink DB with ST card import/export compatibility
- worldbooks: Palink DB with ST world info import/export compatibility
- chats: Palink DB, with ST JSONL compatibility layer
- plugin settings: per-user Palink namespace

## Non-Goals

- Full ST backend ownership.
- Letting ST manage provider keys.
- Letting ST manage TTS/image providers independently.
- Replacing Palink's memory, MCP, model gateway, TTS, or image services with ST.
