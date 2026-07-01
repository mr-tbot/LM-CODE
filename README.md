# LM-CODE

Expose one or more local [LM Studio](https://lmstudio.ai) servers as language models inside GitHub Copilot Chat.

## Features

- Manage **multiple LM Studio servers** (name, URL, API key, custom headers, timeout)
- Global + per-server **refresh interval**
- **Show / hide** individual models from Copilot's model picker
- **Test connection** for each server
- **Import / export** configuration as JSON
- Sidebar tree showing all servers and their models
- Status bar indicator with the live model count

## Settings UI

Run **`LM-CODE: Open Settings Panel`** from the command palette, or click the gear icon in the LM-CODE sidebar.

## Installation (VSIX)

```powershell
npm install
npm run compile
npm run package
code --install-extension lm-code-0.8.0.vsix
```

## Configuration

All settings are stored under `lmstudioCopilot.*` in VS Code settings and can also be edited via the settings panel.
