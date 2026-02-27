---
name: peekaboo
description: macOS screen capture and GUI automation via Peekaboo MCP — take screenshots, read screen content, and interact with desktop applications.
user-invocable: false
---

# Peekaboo Screen Capture & GUI Automation

You have access to macOS screen capture and GUI automation through the Peekaboo MCP server.

## Prerequisites

The Peekaboo MCP server must be configured in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "peekaboo": {
      "command": "npx",
      "args": ["-y", "@steipete/peekaboo"]
    }
  }
}
```

macOS Screen Recording permission must be granted to the terminal application. If the Peekaboo MCP tools are not available, inform the user that setup is required.

## Capabilities

- **Screenshots**: Capture the entire screen, specific windows, or regions
- **OCR**: Extract text content from screenshots
- **Window management**: List open windows, identify active applications
- **GUI interaction**: Click at coordinates, type text, use keyboard shortcuts

## Usage Guidelines

- Take a screenshot first to understand the current screen state before performing any GUI actions.
- Use OCR results to locate UI elements by their text labels.
- Allow a brief pause after GUI actions (clicks, keystrokes) before taking verification screenshots.
- This tool only works on macOS.
