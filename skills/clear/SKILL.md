---
name: clear
description: Clears the current session conversation history and gives the agent a fresh context. Use when the user says "clear session", "forget this conversation", "start fresh", "reset context", "wipe history", or similar.
license: MIT
compatibility: Node.js (handled natively — no Python script required)
metadata:
  author: indotraq-agent
  version: "1.0"
allowed-tools: []
---

# clear

Resets the in-memory session history so the next message starts a brand-new conversation with no prior context.

## When to use

- User says "clear session", "reset", "start fresh", or "forget everything"
- User wants to switch topics and doesn't want prior context bleeding in
- User explicitly asks to wipe or reset the conversation history

## Instructions

This skill is handled natively by the bot via the `/clear` command. No Python script is executed. The bot calls `session.clear()` directly and confirms to the user.

## Example

**Input:** "Clear the session" or `/clear`

**Expected output:**
```
🧹 Session cleared. Starting fresh!
```

## Notes

- Only the in-memory conversation history is cleared. No files or memory documents on disk are affected.
- To also reload agent data and documents, use `/refresh` instead.
