---
name: playwright
description: Browser automation via Playwright MCP — navigate pages, fill forms, take screenshots, and extract data from websites.
user-invocable: false
---

# Playwright Browser Automation

You have access to browser automation capabilities through the Playwright MCP server.

## Prerequisites

The Playwright MCP server must be configured in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

If the Playwright MCP tools are not available, inform the user that the Playwright MCP server needs to be configured first.

## Capabilities

- **Navigation**: Open URLs, click links, go back/forward
- **Interaction**: Click elements, fill forms, select options, press keys
- **Screenshots**: Capture full page or element screenshots
- **Data extraction**: Read page content, extract text, query DOM elements
- **PDF generation**: Save pages as PDF documents

## Usage Guidelines

- Always take a screenshot after navigation to verify the page loaded correctly.
- Use CSS selectors or text content to identify elements.
- Handle cookie consent banners and popups before interacting with page content.
- For multi-step workflows, verify each step completed successfully before proceeding.
