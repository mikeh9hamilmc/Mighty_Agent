#!/usr/bin/env python3
"""
weather skill — get_weather.py

Fetches current conditions for Redington Shores, FL from WeatherBug using
a headless Chromium browser (Playwright) so that the JavaScript-rendered
DOM is fully available before we extract data.
"""

import sys

# Force UTF-8 output so emoji prints correctly on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
except ImportError:
    print(
        "❌ Playwright is not installed.\n"
        "   Run:  pip install playwright && playwright install chromium"
    )
    sys.exit(1)

URL = "https://www.weatherbug.com/weather-forecast/now/redington-shores-fl-33708"

# Selector helpers
# The temperature value and its ° symbol are sibling spans inside a common
# parent, so we select that parent via :has().
SELECTORS = {
    "temperature" : ':has(> [data-test-id="now-today-temperature"])',
    "feels_like"  : '[data-test-id="now-today-feels-like"]',
    "wind"        : '[data-test-id="now-details-avg-wind"]',
}

TIMEOUT_MS = 20_000   # 20 s per element wait


import re

# Label prefixes that WeatherBug may embed inside the element text
_LABEL_PREFIXES = re.compile(
    r'^(feels\s+like\s*:?|wind\s*:?|temperature\s*:?)\s*',
    re.IGNORECASE,
)


def clean_text(raw: str) -> str:
    """Collapse whitespace and strip leading label text from an element's inner text."""
    # Collapse newlines / multiple spaces into a single space
    cleaned = re.sub(r'\s+', ' ', raw).strip()
    # Remove any leading label (e.g. "Feels like:")
    cleaned = _LABEL_PREFIXES.sub('', cleaned).strip()
    # Remove space before degree symbol ("86 °" -> "86°")
    cleaned = re.sub(r'\s*°', '°', cleaned)
    return cleaned


def get_text(page, selector: str, label: str) -> str:
    """Wait for an element and return its cleaned inner text."""
    try:
        el = page.wait_for_selector(selector, timeout=TIMEOUT_MS)
        return clean_text(el.inner_text())
    except PWTimeout:
        return f"(not found — '{label}' element timed out)"
    except Exception as exc:
        return f"(error: {exc})"

def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="en-US",
        )
        page = context.new_page()

        try:
            page.goto(URL, wait_until="domcontentloaded", timeout=30_000)
        except Exception as exc:
            print(f"❌ Failed to load WeatherBug: {exc}")
            browser.close()
            sys.exit(1)

        temperature = get_text(page, SELECTORS["temperature"], "temperature")
        feels_like  = get_text(page, SELECTORS["feels_like"],  "feels like")
        wind        = get_text(page, SELECTORS["wind"],         "wind")

        browser.close()

    print("🌤  Redington Shores, FL — Current Conditions")
    print(f"🌡  Temperature : {temperature}")
    print(f"🤔  Feels Like  : {feels_like}")
    print(f"💨  Wind        : {wind}")


if __name__ == "__main__":
    main()
