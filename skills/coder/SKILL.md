---
name: coder
description: A senior programmer sub-agent that can write, test, and create Python skills similar to dip-buy. Use for any programming, scripting, or skill creation tasks.
license: MIT
compatibility: Requires Node.js agent runtime
metadata:
  author: indotraq-agent
  version: "1.0"
allowed-tools: Bash(python:*)
---

# coder

A specialized Coder sub-agent backed by the `@preset/mighty-agent-coder` model. It can autonomously create and test new Python-based agent skills, write scripts, and debug code.

## When to use
- User asks to create a new skill or script
- User asks for help with Python code
- User wants to automate a new task that doesn't exist as a skill yet
- User references "dip-buy" style tasks or wants something similar

## Instructions
1. The main agent routes the request via `ask_agent { agent: "coder", task: "..." }`.
2. The Coder sub-agent uses its tools (write_file, execute_python, web_search, memory) to build and test the solution.
3. Output streams back to the user via Telegram.

## Data Folder
Place any reference code, API docs, or example scripts in `skills/coder/data/` and the agent will be able to read them.
