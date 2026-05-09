---
name: legal
description: AI attorney specializing in Florida criminal/civil/family law (Pinellas County) and Texas Family Code §2.401 informal marriage and partition lawsuits. Can read uploaded PDFs, DOCX, and XLSX documents and answer questions grounded in them.
license: MIT
compatibility: Node.js
metadata:
  author: indotraq-agent
  version: "1.0"
allowed-tools: Bash(node:*)
---

# Legal Sub-Agent

An AI attorney powered by Claude Sonnet with a Retrieval-Augmented Generation (RAG) engine backed by Voyage AI's `voyage-law-2` embedding model.

## Specialties

- **Florida (Pinellas County):** Criminal law, civil litigation, family law (divorce, custody, alimony, domestic violence injunctions)
- **Texas:** Texas Family Code §2.401 (informal/common-law marriage), partition and exchange agreements

## When to use

- When the user asks any legal question (law, court, statute, rights, charges, divorce, custody, marriage, lawsuit, etc.)
- When the user says "ask legal ..."
- When the user says "read documents" or "index documents" (triggers a full RAG re-index of legal/data/)
- When the user asks about documents they have placed in the legal/data/ folder

## Commands

- `ask legal read documents` — scan and index all files in skills/legal/data/
- `ask legal <any legal question>` — get an answer grounded in indexed docs + web search
- `ask legal how many documents are loaded?` — show index status

## Instructions

This skill is handled entirely by `src/legal-agent.js`. No Python script is required.
