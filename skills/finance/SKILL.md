---
name: finance
description: A specialized sub-agent for financial strategy, stock investing (UPRO), real estate analysis, and tax planning.
license: MIT
compatibility: Requires OpenRouter API
metadata:
  author: indotraq-agent
  version: "1.0"
---

# Finance Agent

A Senior Financial Strategist sub-agent that analyzes your personal financial documents and provides data-driven insights on investing, real estate, and taxes.

## When to use
- When the user asks about stock market strategy or the UPRO ETF.
- When the user needs real estate valuation analysis ($/sq ft).
- When the user asks about CPA tax knowledge and long-term holding strategies.
- When analyzing bank statements, tax returns, or investment portfolio documents.

## Instructions
1. Use the "ask finance <question>" prefix to route directly.
2. The agent will search your documents in `skills/finance/data/`.
3. It provides sophisticated, data-driven financial advice.
