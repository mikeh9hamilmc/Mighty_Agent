---
name: weather
description: Fetches current weather conditions for Redington Shores, FL — temperature, feels-like temperature, and wind details. Use when the user asks about the weather, temperature, how hot/cold it is, or wind conditions.
license: MIT
compatibility: Requires Python 3.x and the 'playwright' package with Chromium installed. Run 'pip install playwright && playwright install chromium' once to set up.
metadata:
  author: indotraq-agent
  version: "1.0"
allowed-tools: Bash(python:*)
---

# weather

Scrapes live weather data for **Redington Shores, FL (33708)** from WeatherBug and returns a concise summary.

## Setup (one-time)

```bash
pip install playwright
playwright install chromium
```

## When to use

- "What's the weather like?"
- "How hot is it outside?"
- "What's the wind speed?"
- "Is it a nice day?"

## Instructions

1. Run `scripts/get_weather.py`.
2. Capture its stdout output.
3. Return the weather summary directly to the user.

## Example output

```
🌤 Redington Shores, FL — Current Conditions
🌡 Temperature : 82°F
🤔 Feels Like  : 88°F
💨 Wind        : NE 12 mph
```

## Edge cases

- The page is JavaScript-rendered; the script uses a headless Chromium browser via Playwright.
- If an element is not found within the timeout the script exits with a descriptive error message.
- Network outages or WeatherBug site changes may cause failures — the script will report what went wrong.
- First run after setup may take a few extra seconds while Chromium initialises.
