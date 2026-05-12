---
name: travel
description: A specialized sub-agent for travel planning, flight prices, hotels, cars, and cruises using Kayak and web search.
---
# Travel Agent

This is a sub-agent directory. The main LLM router delegates complex travel queries here.

## Capabilities
- Web search using Brave (via `document-tools.js`).
- Reading/searching user travel documents in `data/`.
- Persistent strategic memory in `memory/`.

## Routing
Users can directly invoke this agent via:
`ask travel, find me a flight to tokyo next month`
