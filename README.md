# OpenClaw plugin for Agent Control

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/cat-plus-lobster-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/cat-plus-lobster-light.svg">
    <img src="https://cdn.jsdelivr.net/npm/agent-control-openclaw-plugin/assets/cat-plus-lobster-light.svg" alt="Agent Control cat plus OpenClaw lobster" width="430">
  </picture>
</p>

This plugin integrates OpenClaw with [Agent Control](https://github.com/agentcontrol/agent-control), a security and policy layer for agent tool use. It registers OpenClaw tools with Agent Control and can block unsafe tool invocations before they execute.

## Why use Agent Control with OpenClaw?

- Enforce policy before tool execution, so unsafe or disallowed actions can be blocked before they run.
- Carry session and channel context into evaluations, which helps policies reason about where a request came from and how the agent is being used.

> [!WARNING]
> Experimental plugin: this  may break across OpenClaw updates. Use in non-production or pinned environments.

## Install from npm

Install the published plugin directly into OpenClaw:

```bash
openclaw plugins install agent-control-openclaw-plugin
```

Then restart the gateway.

## Local dev install

1. Clone this repo anywhere on disk.
2. Install plugin deps in this repo:

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run coverage
```

Coverage reports are written to `coverage/`, including `coverage/lcov.info` for Codecov-compatible uploads. The GitHub Actions workflow will upload that report to Codecov automatically when a `CODECOV_TOKEN` secret is configured for the repository.

3. Link it into your OpenClaw config from your OpenClaw checkout:

```bash
openclaw plugins install -l /absolute/path/to/openclaw-plugin
```

4. Restart gateway.

## OpenClaw commands

```bash
# Inspect plugin state
openclaw plugins list
openclaw plugins info agent-control-openclaw-plugin
openclaw plugins doctor

# Enable / disable
openclaw plugins enable agent-control-openclaw-plugin
openclaw plugins disable agent-control-openclaw-plugin

# Configure plugin entry + settings
openclaw config set plugins.entries.agent-control-openclaw-plugin.enabled true --strict-json
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.serverUrl "http://localhost:8000"
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.apiKey "ac_your_api_key"
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.agentName "openclaw-agent"
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.timeoutMs 15000 --strict-json
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.failClosed false --strict-json

# Optional settings
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.logLevel "info"
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.logLevel "debug"
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.agentId "00000000-0000-4000-8000-000000000000"
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.agentVersion "2026.3.3"
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.userAgent "agent-control-plugin/0.1"

# Remove optional keys
openclaw config unset plugins.entries.agent-control-openclaw-plugin.config.apiKey
openclaw config unset plugins.entries.agent-control-openclaw-plugin.config.logLevel
openclaw config unset plugins.entries.agent-control-openclaw-plugin.config.debug
openclaw config unset plugins.entries.agent-control-openclaw-plugin.config.agentId
openclaw config unset plugins.entries.agent-control-openclaw-plugin.config.agentVersion
openclaw config unset plugins.entries.agent-control-openclaw-plugin.config.userAgent

# Uninstall plugin link/install record from OpenClaw config
openclaw plugins uninstall agent-control-openclaw-plugin --force
```

By default the plugin stays quiet and only emits warnings, errors, and tool block events.

Set `config.logLevel` to:

- `info` for one-line lifecycle logs such as client init, warmup, and agent syncs
- `debug` for verbose startup, sync, and evaluation diagnostics

The older `config.debug` flag is still accepted as a deprecated alias for `logLevel=debug`.
