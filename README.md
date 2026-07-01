# LM-CODE

LM-CODE lets you use one or more LM Studio servers as models inside GitHub Copilot Chat in VS Code.

## What You Get

- Connect multiple LM Studio servers.
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
code --install-extension lm-code-0.8.0.vsix
```

### Option B: Build and install locally

```powershell
npm install
npm run compile
npm run package
code --install-extension lm-code-0.8.0.vsix
```

## Configure LM-CODE

### Use the Settings Panel (easiest)

1. Run `LM-CODE: Open Settings Panel`.
2. Click Add Server.
3. Fill in:
	 - Display name: friendly name (example: `Local LM Studio`)
	 - Base URL: LM Studio endpoint (example: `http://localhost:1234`)
	 - API key: optional (leave empty for local default setup)
	 - Timeout: default `60000`
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
			"timeoutMs": 60000,
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
4. Increase timeout from `60000` if your host is slow.

### Copilot Chat does not show LM Studio models

1. Ensure GitHub Copilot Chat is installed and enabled.
2. Reload VS Code window.
3. Re-open LM-CODE panel and refresh models.
4. Ensure server is enabled in LM-CODE settings.

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
