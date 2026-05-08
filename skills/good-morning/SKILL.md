---
name: good-morning
description: Sends a warm morning greeting combined with the current weather report. Use this for the daily morning greeting or when the user wants to start their day with a status update.
license: MIT
compatibility: Requires Python 3.x
metadata:
  author: indotraq-agent
  version: "1.0"
allowed-tools: Bash(python:*)
---

# good-morning

Combines a friendly greeting with the latest weather information for Redington Shores, FL.

## When to use

- During the scheduled 9:00 AM daily check-in.
- When the user says "Good morning" or "Start my day".
- When the user wants a combined greeting and weather update.

## Instructions

1. Run the script `scripts/good_morning.py`.
2. The script will automatically fetch the weather using the `weather` skill's logic.
3. Return the full formatted greeting to the user.

## Example

**Input:** "Good morning!"

**Expected output:**
```
☀️ Good morning! I hope you have a great day.

🌤  Redington Shores, FL — Current Conditions
🌡  Temperature : 78°F
🤔  Feels Like  : 80°F
💨  Wind        : 5 mph
```
