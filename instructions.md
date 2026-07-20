# LM-CODE Instructions

This guide is written for end users who want LM-CODE working fast with minimal setup.

## 1) Install Requirements

1. Install VS Code 1.95.0 or newer.
2. Install and sign in to GitHub Copilot + Copilot Chat.
3. Install LM Studio.
4. In LM Studio, load at least one model.
5. Ensure LM Studio local API is enabled.

## 2) Confirm LM Studio API Is Running

Open this URL in your browser:

http://localhost:1234/v1/models

If you see JSON with a model list, your server is ready.

## 3) Install LM-CODE

Choose one option.

### Option A: Install from VSIX release

1. Download the latest `lm-code-<version>.vsix` from GitHub Releases.
2. Run:

```powershell
code --install-extension lm-code-0.9.0.vsix
```

### Option B: Build from source

```powershell
npm install
npm run compile
npm run package
code --install-extension lm-code-0.9.0.vsix
```

## 4) First-Time Configuration

1. Open Command Palette in VS Code.
2. Run `LM-CODE: Open Settings Panel`.
3. Click Add Server.
4. Fill these fields:
   - Display name: Local LM Studio
   - Base URL: http://localhost:1234
   - API key: leave blank unless your endpoint requires it
   - Timeout (ms): 300000
5. Click Test connection.
6. Click Refresh Now.
7. Select or hide models as needed.

## 5) Verify It Works

1. Open Copilot Chat.
2. Open model picker.
3. Choose one of your LM Studio models.
4. Send a simple prompt like: `Say hello`.

## 6) Add More Servers (Optional)

You can add additional local or remote LM Studio-compatible endpoints.

For each server:

1. Add server in LM-CODE panel.
2. Set URL.
3. Add API key or headers if required.
4. Test connection.
5. Refresh models.

### Using LM Link

If your machines are connected with LM Link, every machine reports the whole network's
models. Either add just one hub machine (it exposes everything, no duplicates), or add
each machine and let LM-CODE de-duplicate the picker automatically. Use the
"De-duplicate across servers" checkbox in the settings panel and the per-server
"Show duplicate models" toggle to control this. If a server cannot serve a model,
LM-CODE automatically fails over to another server that lists it.

## 7) Recommended Settings

- Keep global refresh at `60` seconds for normal usage.
- Set per-server refresh override to `0` to inherit global refresh.
- Disable servers you are not actively using.

## 8) Common Issues and Fixes

### Problem: No models are listed

- Confirm LM Studio is running.
- Confirm a model is loaded.
- Verify endpoint in browser: http://localhost:1234/v1/models
- Run `LM-CODE: Refresh Models Now`.

### Problem: Connection test fails

- Verify URL is correct.
- Check VPN/proxy/firewall.
- Add required API key.
- Increase timeout (for slower hosts).

### Problem: Models do not appear in Copilot picker

- Reload VS Code window.
- Confirm Copilot Chat is enabled.
- Confirm server is enabled in LM-CODE.
- Refresh models in LM-CODE.

## 9) Export and Import Configuration

Use these commands:

- `LM-CODE: Export Configuration`
- `LM-CODE: Import Configuration`

Important: exported files can include API keys. Treat them as sensitive.

## 10) Security Checklist

- Never commit `.env` files, API keys, or private certs.
- Keep exported config files private.
- Rotate keys if they were ever shared accidentally.

## 11) Uninstall

```powershell
code --uninstall-extension monsi.lm-code
```

## 12) Where to Get Help

Open an issue in this repo with:

1. Your VS Code version.
2. Your LM Studio version.
3. Whether `http://localhost:1234/v1/models` returns JSON.
4. Any LM-CODE error message shown in VS Code.
