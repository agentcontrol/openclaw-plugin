# @agentcontrol/agent-control

Agent Control plugin for OpenClaw.

## Local dev install (no publish)

1. Clone this repo anywhere on disk.
2. Install plugin deps in this repo:

```bash
npm install --ignore-scripts
```

3. Link it into your OpenClaw config from your OpenClaw checkout:

```bash
openclaw plugins install -l /absolute/path/to/agent-control
```

4. Restart gateway.

## Config

Set plugin config under `plugins.entries.agent-control`:

```json
{
  "plugins": {
    "entries": {
      "agent-control": {
        "enabled": true,
        "config": {
          "serverUrl": "http://localhost:8000",
          "apiKey": "<optional>",
          "agentName": "openclaw-agent",
          "failClosed": false
        }
      }
    }
  }
}
```
