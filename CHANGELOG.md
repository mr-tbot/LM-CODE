# Changelog

All notable changes to LM-CODE.

## 0.10.0 — 2026-07-20

### LM Link aware model management

With LM Link, every machine on the link reports the whole network's models, so adding
several servers to LM-CODE produced duplicate and triplicate entries in the Copilot
model picker. This release adds:

- **Cross-server de-duplication** (`lmstudioCopilot.dedupeAcrossServers`, default on):
  each model appears once, provided by the first enabled server that lists it (server
  order = priority). Tooltips show which other servers also have the model.
- **Per-server "Show duplicate models" toggle** (`showDuplicateModels` per server, also
  in the settings panel and as a click-to-toggle row in the sidebar tree): keep a
  specific server's copies visible, labeled as duplicates.
- **Within-server de-duplication**: LM Link can inject the same model into one server's
  listing twice; those are always collapsed.
- **Automatic cross-server failover**: if the chosen server cannot serve a model
  (machine unreachable, model not found, LM Link drop, load failure) and nothing has
  been streamed yet, LM-CODE transparently retries the same model on every other
  configured server that lists it — always against live server config, one attempt
  per alternate. Timeouts and generic 500s deliberately do not cascade.
- **Hiding follows the model, not the copy** (when de-dupe is on): hiding a model hides
  that model identity everywhere, so it cannot resurrect from a mirror server. With
  de-dupe off, hiding stays per-server as before.
- Robustness: stale in-flight refreshes can no longer resurrect disabled/removed
  servers; unchanged refresh ticks no longer reset the model picker; settings-panel
  edits can no longer be reverted by a concurrent refresh; each server's panel/tree
  section shows its own full listing (mirrored servers no longer look empty).
- Settings panel: global de-dupe checkbox, per-server duplicate toggle, and
  "duplicate of…" / "also on…" badges on model rows. Sidebar tree shows duplicate
  counts per server with one-click toggling.

Note: LM Studio's REST API does not report which LM Link device a model lives on, so
de-duplication is by model identity. See the README's "LM Link setups" section for the
two recommended configurations.

## 0.9.0 — 2026-07-20

### Comprehensive tool-call support for local models

- Native tool-markup parser covering: Hermes/Qwen `<tool_call>` JSON, Qwen3-Coder XML,
  Gemma ` ```tool_code ` Python calls, DeepSeek R1/V3/V3.1 special tokens, Mistral
  `[TOOL_CALLS]`, Llama `<|python_tag|>`, Kimi K2 section tokens, GLM
  `<arg_key>/<arg_value>`, MiniMax/Claude-style `<invoke>` XML, Granite `<|tool_call|>`,
  LM Studio's `[TOOL_REQUEST]` bridge, bare-JSON calls, and Python dict literals —
  all safe against arbitrary streaming chunk splits.
- Model discovery via `/api/v0/models`: real context windows, native-vs-bridged tool
  support, image input for vision models; correct token accounting for tool calls.
- Mid-stream server errors surfaced instead of silent empty responses; readable
  formatting for JSON/HTML error bodies; hidden-reasoning-only responses explained.
- `reasoning_content` (thinking) deltas handled and filtered from chat output.
- One automatic retry on transient load failures; cancellation honored during backoff;
  truncated tool calls dropped instead of being sent broken; hung-connection fixes.
- System role, image DataParts, and `modelOptions` sampling passthrough.
- Default timeout raised 60 s → 300 s (JIT model loads can take minutes).

## 0.8.0

- Initial public release: multiple LM Studio servers as Copilot Chat models, settings
  panel, sidebar tree, model hiding, import/export, auto-refresh.
