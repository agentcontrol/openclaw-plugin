# @agentcontrol/agent-control

Agent Control plugin for OpenClaw.

> [!WARNING]
> Experimental plugin: this project is currently a hacky integration and may
> break across OpenClaw updates. Use in non-production or pinned environments.

## Install from npm

Install the published plugin directly into OpenClaw:

```bash
openclaw plugins install @agentcontrol/agent-control
```

Then restart the gateway.

## Local dev install

1. Clone this repo anywhere on disk.
2. Install plugin deps in this repo:

```bash
npm install
```

3. Link it into your OpenClaw config from your OpenClaw checkout:

```bash
openclaw plugins install -l /absolute/path/to/openclaw-plugin
```

4. Restart gateway.

## Publish a release

1. Configure npm trusted publishing once for this repo:

In the npm package settings, add a GitHub Actions trusted publisher for the
`agentcontrol/openclaw-plugin` repository and the
`.github/workflows/release.yml` workflow file.

2. Merge your release changes to `main`, then bump the package version locally:

```bash
npm version patch
```

3. Push `main` and the version tag:

```bash
git push origin main --follow-tags
```

GitHub Actions will run `.github/workflows/release.yml`, verify the tag matches
`package.json`, lint the package, run `npm pack --dry-run`, and publish to npm
with provenance.

## Manual release checks

Before pushing a release tag, you can run the publish checks locally:

```bash
npm pack --dry-run
npm publish --dry-run
```

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
