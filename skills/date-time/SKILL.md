---
name: date-time
description: Reads and returns the current local date and time. Use when the user asks what time or date it is, wants a timestamp, or needs to know the current day, month, or year.
license: MIT
compatibility: Requires Python 3.x
metadata:
  author: indotraq-agent
  version: "1.0"
allowed-tools: Bash(python:*)
---

# date-time

Returns the current local date and time as a formatted string.

## When to use

- User asks "What time is it?" or "What's today's date?"
- User needs a timestamp for a log entry or filename
- Any request involving the current moment in time

## Instructions

1. Run the script `scripts/get_datetime.py`.
2. Capture its stdout output.
3. Return the formatted date/time string directly to the user.

## Example

**Input:** "What's the current date and time?"

**Expected output:**
```
2026-05-06 13:35:30  (Tuesday, 06 May 2026)
```

## Edge cases

- The script always uses the **local system timezone** — no network access required.
- If the system clock is wrong the output will reflect that; nothing in this skill corrects clock drift.
