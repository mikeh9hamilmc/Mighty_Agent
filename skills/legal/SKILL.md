---
name: legal
description: A specialized legal sub-agent that can research case documents, search legal statutes, and draft legal documents. Use for any legal questions, case strategy, or document review.
license: MIT
metadata:
  author: indotraq-agent
  version: "1.0"
---

# legal

The legal skill provides access to an autonomous legal researcher and assistant.

## Capabilities

- **Document Analysis**: Search and read through case files in `skills/legal/data/`.
- **Statutory Research**: Search Florida and Texas statutes via Brave Search.
- **Document Drafting**: Create legal motions, affidavits, and correspondence in Markdown.
- **Conversion**: Convert drafted Markdown documents to Word (.docx) format.
- **Memory**: Remembers case strategies and critical facts across sessions.

## Usage

You can invoke this skill by asking a legal question directly, or by prefixing your message with "ask legal: ".

**Example:**
"ask legal: summarize the Hamilton v. Le partition action"
"What is the 2-year separation presumption in Texas common law marriage?"
