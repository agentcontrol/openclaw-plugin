# @agentcontrol/agent-control

Agent Control plugin for OpenClaw.

> [!WARNING]
> Experimental plugin: this project is currently a hacky integration and may
> break across OpenClaw updates. Use in non-production or pinned environments.

## Local dev install (no publish)

1. Clone this repo anywhere on disk.
2. Install plugin deps in this repo:

```bash
npm install --ignore-scripts
```

3. Link it into your OpenClaw config from your OpenClaw checkout:

```bash
openclaw plugins install -l /absolute/path/to/openclaw-plugin
```

4. Restart gateway.

## OpenClaw commands

```bash
# Inspect plugin state
openclaw plugins list
openclaw plugins info agent-control
openclaw plugins doctor

# Enable / disable
openclaw plugins enable agent-control
openclaw plugins disable agent-control

# Configure plugin entry + settings
openclaw config set plugins.entries.agent-control.enabled true --strict-json
openclaw config set plugins.entries.agent-control.config.serverUrl "http://localhost:8000"
openclaw config set plugins.entries.agent-control.config.apiKey "ac_your_api_key"
openclaw config set plugins.entries.agent-control.config.agentName "openclaw-agent"
openclaw config set plugins.entries.agent-control.config.timeoutMs 15000 --strict-json
openclaw config set plugins.entries.agent-control.config.failClosed false --strict-json

# Optional settings
openclaw config set plugins.entries.agent-control.config.agentId "00000000-0000-4000-8000-000000000000"
openclaw config set plugins.entries.agent-control.config.agentVersion "2026.3.3"
openclaw config set plugins.entries.agent-control.config.userAgent "agent-control-plugin/0.1"

# Remove optional keys
openclaw config unset plugins.entries.agent-control.config.apiKey
openclaw config unset plugins.entries.agent-control.config.agentId
openclaw config unset plugins.entries.agent-control.config.agentVersion
openclaw config unset plugins.entries.agent-control.config.userAgent

# Uninstall plugin link/install record from OpenClaw config
openclaw plugins uninstall agent-control --force
```
