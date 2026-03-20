# OpenClaw plugin for Agent Control

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/cat-plus-lobster-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/cat-plus-lobster-light.svg">
    <img src="https://cdn.jsdelivr.net/npm/agent-control-openclaw-plugin/assets/cat-plus-lobster-light.svg" alt="Agent Control cat plus OpenClaw lobster" width="430">
  </picture>
  <br>
  <a href="https://www.npmjs.com/package/agent-control-openclaw-plugin">
    <img src="https://img.shields.io/npm/v/agent-control-openclaw-plugin?logo=npm" alt="npm version">
  </a>
  <a href="https://github.com/agentcontrol/openclaw-plugin/blob/main/package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white" alt="Node 24 or newer">
  </a>
  <a href="https://github.com/agentcontrol/openclaw-plugin/actions/workflows/lint.yml">
    <img src="https://github.com/agentcontrol/openclaw-plugin/actions/workflows/lint.yml/badge.svg" alt="CI">
  </a>
  <a href="https://app.codecov.io/gh/agentcontrol/openclaw-plugin">
    <img src="https://codecov.io/gh/agentcontrol/openclaw-plugin/graph/badge.svg?branch=main" alt="Codecov">
  </a>
</p>

This plugin integrates OpenClaw with [Agent Control](https://github.com/agentcontrol/agent-control), a security and policy layer for agent tool use. It registers OpenClaw tools with Agent Control and can block unsafe tool invocations before they execute.

> [!WARNING]
> Experimental plugin: this may break across OpenClaw updates. Use in non-production or pinned environments.

## Why use this?

- Enforce policy before tool execution, so unsafe or disallowed actions never run.
- Carry session and channel context into evaluations, so policies can reason about where a request came from and how the agent is being used.

## How it works

When the gateway starts, the plugin loads the OpenClaw tool catalog and syncs it to Agent Control. On every tool call, the plugin intercepts the invocation through a `before_tool_call` hook, builds an evaluation context (session, channel, provider, agent identity), and sends it to Agent Control for a policy decision. If the evaluation comes back safe the call proceeds normally. If it comes back denied the call is blocked and the user sees a rejection message.

The plugin handles multiple agents, tracks tool catalog changes between calls, and re-syncs automatically when the catalog drifts.

## Quick start

Install and configure with the minimum required settings:

```bash
openclaw plugins install agent-control-openclaw-plugin

openclaw config set plugins.entries.agent-control-openclaw-plugin.enabled true
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.serverUrl "http://localhost:8000"
```

Restart the gateway. The plugin is now active with fail-open defaults and warn-level logging.

For authenticated setups, also set:

```bash
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.apiKey "ac_your_api_key"
```

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `serverUrl` | string | — | Base URL for the Agent Control server. **Required.** |
| `apiKey` | string | — | API key for authenticating with Agent Control. |
| `agentName` | string | `openclaw-agent` | Base name used when registering agents with Agent Control. |
| `agentVersion` | string | — | Version string sent to Agent Control during agent sync. |
| `timeoutMs` | integer | SDK default | Client timeout in milliseconds. |
| `failClosed` | boolean | `false` | Block tool calls when Agent Control is unreachable. See [Fail-open vs fail-closed](#fail-open-vs-fail-closed). |
| `logLevel` | string | `warn` | Logging verbosity. See [Logging](#logging). |
| `userAgent` | string | `openclaw-agent-control-plugin/0.1` | Custom User-Agent header for requests to Agent Control. |

All settings are configured through the OpenClaw CLI:

```bash
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.<key> <value>
```

### Environment variables

`serverUrl` and `apiKey` can also be set through environment variables. This is useful in container or CI environments where you do not want secrets in the OpenClaw config file.

| Variable | Equivalent config |
|----------|-------------------|
| `AGENT_CONTROL_SERVER_URL` | `serverUrl` |
| `AGENT_CONTROL_API_KEY` | `apiKey` |

Config values take precedence over environment variables when both are set.

## Fail-open vs fail-closed

By default, the plugin is **fail-open**: if Agent Control is unreachable or the evaluation request fails, tool calls are allowed through. This avoids breaking your gateway when Agent Control has a transient outage.

Set `failClosed` to `true` if you need the guarantee that no tool call executes without a policy decision. In fail-closed mode, a sync failure or evaluation error will block the tool call.

```bash
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.failClosed true
```

## Logging

The plugin stays quiet by default and only emits warnings, errors, and tool block events.

| Level | What it logs |
|-------|-------------|
| `warn` | Warnings, errors, and block events. This is the default. |
| `info` | Adds lifecycle events: client init, gateway warmup, agent syncs. |
| `debug` | Adds verbose diagnostics: phase timings, context building, evaluation details. |

```bash
openclaw config set plugins.entries.agent-control-openclaw-plugin.config.logLevel "debug"
```

## OpenClaw CLI reference

### Inspect plugin state

```bash
openclaw plugins list
openclaw plugins info agent-control-openclaw-plugin
openclaw plugins doctor
```

### Enable or disable

```bash
openclaw plugins enable agent-control-openclaw-plugin
openclaw plugins disable agent-control-openclaw-plugin
```

### Remove optional config keys

```bash
openclaw config unset plugins.entries.agent-control-openclaw-plugin.config.apiKey
openclaw config unset plugins.entries.agent-control-openclaw-plugin.config.logLevel
openclaw config unset plugins.entries.agent-control-openclaw-plugin.config.agentVersion
openclaw config unset plugins.entries.agent-control-openclaw-plugin.config.userAgent
```

### Uninstall

```bash
openclaw plugins uninstall agent-control-openclaw-plugin --force
```

## Local development

1. Clone this repo anywhere on disk.
2. Install dependencies and run the verification stack:

```bash
npm install
npm run lint
npm run typecheck
npm test
```

3. Link the plugin into your OpenClaw checkout:

```bash
openclaw plugins install -l /absolute/path/to/openclaw-plugin
```

4. Restart the gateway.

`npm run coverage` generates a report under `coverage/` including `coverage/lcov.info` for Codecov uploads.

## Contributing

See [AGENTS.md](AGENTS.md) for project conventions, testing patterns, and the verification checklist.

## License

[Apache 2.0](LICENSE)
