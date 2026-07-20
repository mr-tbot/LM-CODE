# LM-CODE

LM-CODE lets you use one or more LM Studio servers as models inside GitHub Copilot Chat in VS Code.

## What You Get

- Connect multiple LM Studio servers.
- Full tool-calling (agent mode) support, including models that emit native tool-call markup instead of OpenAI-format tool calls. Recognized dialects: Hermes/Qwen `<tool_call>` JSON, Qwen3-Coder XML (`<function=`/`<parameter=`), Gemma ` ```tool_code ` Python calls, DeepSeek R1/V3/V3.1 special tokens, Mistral `[TOOL_CALLS]`, Llama `<|python_tag|>`, Kimi K2 section tokens, GLM `<arg_key>/<arg_value>`, MiniMax/Claude-style `<invoke>` XML, Granite `<|tool_call|>`, LM Studio's `[TOOL_REQUEST]` bridge, bare-JSON calls, and Python dict literals — so Llama, Qwen, Mistral, Grok, DeepSeek, Kimi, GLM, Gemma, Granite, MiniMax and similar local models work out of the box.
- Capability-aware model discovery via LM Studio's REST API: real context lengths, native-vs-bridged tool support shown per model, and image input for vision models.
- Reasoning models (Qwen 3, DeepSeek R1, etc.) handled correctly: thinking output is filtered out of chat responses.
- Robust streaming: mid-stream server errors are reported clearly instead of producing silent empty responses, and transient model-load failures are retried automatically.
- Generous timeouts for just-in-time model loading (large models can take minutes to load before the first token).
- Test each server connection directly from the extension UI.
- Auto-refresh available models.
- Hide models you do not want in your picker.
- Import and export full configuration JSON.
- View all servers and models in a dedicated sidebar.

## Prerequisites

Before installing LM-CODE, make sure you have:

1. VS Code 1.95.0 or newer.
2. GitHub Copilot and Copilot Chat enabled in VS Code.
3. LM Studio installed and running.
4. At least one model loaded in LM Studio.
5. LM Studio API endpoint enabled (default is usually `http://localhost:1234`).

## Quick Start (Recommended)

1. Install LM Studio and load a model.
2. Verify LM Studio API is reachable at `http://localhost:1234/v1/models`.
3. Install LM-CODE.
4. Open Command Palette and run `LM-CODE: Open Settings Panel`.
5. Add your server URL and click Test connection.
6. Open Copilot Chat and select an LM Studio model.

## Installation

You can install LM-CODE in two ways.

### Option A: Install from a VSIX release file

1. Download the latest `.vsix` from this repository's Releases page.
2. Install using VS Code:

```powershell
code --install-extension lm-code-0.9.0.vsix
```

### Option B: Build and install locally

```powershell
npm install
npm run compile
npm run package
code --install-extension lm-code-0.9.0.vsix
```

## Configure LM-CODE

### Use the Settings Panel (easiest)

1. Run `LM-CODE: Open Settings Panel`.
2. Click Add Server.
3. Fill in:
   - Display name: friendly name (example: `Local LM Studio`)
   - Base URL: LM Studio endpoint (example: `http://localhost:1234`)
   - API key: optional (leave empty for local default setup)
   - Timeout: default `300000` (5 min — large models can take a while to load on first request)
4. Click Test connection.
5. Click Refresh Now to pull models.
6. Uncheck models you want hidden from Copilot picker.

### Configure in VS Code settings.json

LM-CODE settings are under `lmstudioCopilot.*`.

Example:

```json
{
  "lmstudioCopilot.refreshIntervalSec": 60,
  "lmstudioCopilot.showStatusBar": true,
  "lmstudioCopilot.servers": [
    {
      "id": "local",
      "name": "Local LM Studio",
      "baseUrl": "http://localhost:1234",
      "apiKey": "",
      "enabled": true,
      "timeoutMs": 300000,
      "headers": {},
      "refreshIntervalSec": 0,
      "hiddenModels": []
    }
  ]
}
```

## Commands

- `LM-CODE: Open Settings Panel`
- `LM-CODE: Refresh Models Now`
- `LM-CODE: Add Server`
- `LM-CODE: Export Configuration`
- `LM-CODE: Import Configuration`

## Troubleshooting

### No models appear

1. Confirm LM Studio is running.
2. Confirm a model is loaded in LM Studio.
3. Open `http://localhost:1234/v1/models` in browser.
4. Click `LM-CODE: Refresh Models Now`.

### Test connection fails

1. Verify Base URL is correct and does not end with extra path segments.
2. If using remote server, confirm firewall/network access.
3. If your server requires auth, set API key or custom headers.
4. Increase timeout from `300000` if your host is slow.

### Copilot Chat does not show LM Studio models

1. Ensure GitHub Copilot Chat is installed and enabled.
2. Reload VS Code window.
3. Re-open LM-CODE panel and refresh models.
4. Ensure server is enabled in LM-CODE settings.

### Tool calls fail or look wrong for a particular model

Hover the model in the picker: "native tools" means the model's chat template handles tool
calls itself; "bridged tools" means LM Studio injects a prompt-based tool format, which is
more fragile on small or heavily quantized models. Check each model's reported capabilities
at `http://localhost:1234/api/v0/models`.

### The response is empty or cuts off

- Check the `LM-CODE` output channel (View > Output > LM-CODE) — mid-stream server errors
  (for example "Model unloaded.") are logged there and surfaced in chat.
- Reasoning models think before answering; the thinking is hidden. If a model spends its
  entire output budget thinking, LM-CODE tells you in the response.

### First request to a model is slow or times out

LM Studio loads models just-in-time; large models can take minutes before the first token.
LM-CODE waits up to the per-server timeout (default 5 minutes) and automatically retries
once when LM Studio reports a transient load failure.

## Security Notes

- Keep API keys local to your machine.
- Do not commit private keys or secrets to source control.
- Exported config files may contain API keys; treat them as sensitive.

## Developer Notes

Build commands:

```powershell
npm install
npm run compile
npm run lint
npm run package
```

## License

MIT
