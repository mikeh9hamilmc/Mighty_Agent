---
name: music
description: >
  Fetches live music schedules for a given location and date by scraping GoTonight.
  Use when the user asks about live music, bands playing nearby, concerts at bars, or local music events.
  Accepts an optional location (default: Redington Shores, FL) and optional date in YYYY-MM-DD format (default: today).
  Examples: "what live music is near me tonight", "find live music in Clearwater tomorrow", "who is playing at local bars this weekend".
inputs:
  - name: location
    description: City, town, or area to search (e.g. "Clearwater, FL"). Defaults to Redington Shores, FL.
    required: false
  - name: date
    description: Date to search in YYYY-MM-DD format (e.g. "2026-05-22"). Defaults to today's date.
    required: false
---

# Music Skill

This skill fetches live music schedules from GoTonight by using a cloud browser session to bypass WAF protections.

## Execution

The script accepts two optional command-line arguments:
1. `date` — in `YYYY-MM-DD` format (if not provided, defaults to today)
2. `location` — any remaining arguments joined together (if not provided, defaults to Redington Shores, FL)

## Output Format

Results are printed in markdown grouped by venue, sorted alphabetically:

```
## Live Music Schedule for [Location] ([Date])

- **Bamboo Beach Bar & Grille Mad Beach**
  - **Artist:** Hollywood
  - **Time:** Thu., May. 21st 2026 @ 12:30 PM - 3:30 PM
```

If no events are found: `No live music schedules found on GoTonight for [Location] on [Date].`
