#!/usr/bin/env python3
"""
music.py — Live Music Schedule Fetcher
=======================================
Fetches live music schedules from GoTonight using a cloud browser session
(via browser-use) to bypass WAF protections. Fires jQuery AJAX POST inside
the browser page to get real event data, then parses the HTML cards.

Usage:
    python music.py [YYYY-MM-DD] [location words...]

Defaults:
    date     = today
    location = Redington Shores, FL  (lat: 27.8406, lon: -82.8315)
"""

import asyncio
import json
import os
import re
import sys
from datetime import date as DateClass

from bs4 import BeautifulSoup
from dotenv import load_dotenv
from geopy.geocoders import Nominatim

# ── Environment ────────────────────────────────────────────────────────────────
env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
load_dotenv(dotenv_path=os.path.abspath(env_path))

# ── Defaults ───────────────────────────────────────────────────────────────────
DEFAULT_LOCATION = "Redington Shores, FL"
#  https://gotonight.com/?view=list&date=2026-05-22&latitude=27.76683788325855&longitude=-82.7759104451111&zoom=12 
DEFAULT_LAT = 27.76683788325855
DEFAULT_LON = -82.7759104451111
# Bounding box deltas for the map viewport (approx ±0.08 deg = ~9km)
DELTA = 0.08


# ── Argument Parsing ───────────────────────────────────────────────────────────

def parse_args():
    """
    Parse sys.argv into (date_str, location_str).
    First arg matching YYYY-MM-DD is used as the date; remaining args form the location.
    """
    args = sys.argv[1:]
    date_str = None
    location_parts = []

    date_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")
    for arg in args:
        if date_str is None and date_pattern.match(arg):
            date_str = arg
        else:
            location_parts.append(arg)

    if date_str is None:
        date_str = DateClass.today().isoformat()

    location = " ".join(location_parts).strip() if location_parts else DEFAULT_LOCATION
    return date_str, location


# ── Geocoding ──────────────────────────────────────────────────────────────────

def resolve_location(location: str):
    """
    Convert a location name to (lat, lon).
    Returns (lat, lon, resolved_name).
    Falls back to Redington Shores defaults if geocoding fails.
    """
    if location.lower() == DEFAULT_LOCATION.lower():
        return DEFAULT_LAT, DEFAULT_LON, DEFAULT_LOCATION

    try:
        geolocator = Nominatim(user_agent="mighty-agent-music/1.0")
        result = geolocator.geocode(location, timeout=10)
        if result:
            return result.latitude, result.longitude, result.address
    except Exception:
        pass

    # Fallback
    return DEFAULT_LAT, DEFAULT_LON, DEFAULT_LOCATION


# ── GoTonight Fetcher ──────────────────────────────────────────────────────────

AJAX_SCRIPT_TEMPLATE = """\
() => new Promise((resolve) => {{
    if (typeof window.$ === 'undefined') {{
        resolve(JSON.stringify({{ error: 'jQuery not loaded' }}));
        return;
    }}
    $.ajax({{
        type: 'POST',
        url: '/Map/ReadEventViews',
        data: {{
            "date": "{date}T00:00:00.000Z",
            "isToday": "{is_today}",
            "whereLocationId": "",
            "center[latitude]": "{lat}",
            "center[longitude]": "{lon}",
            "bounds[northWest][latitude]": "{north}",
            "bounds[northWest][longitude]": "{west}",
            "bounds[southEast][latitude]": "{south}",
            "bounds[southEast][longitude]": "{east}",
            "zoom": "12"
        }},
        success: function(data) {{ resolve(JSON.stringify({{ success: true, data: data }})); }},
        error: function(xhr, status, err) {{ resolve(JSON.stringify({{ success: false, error: status + ': ' + err }})); }}
    }});
}})
"""


async def fetch_events(date_str: str, lat: float, lon: float) -> list[str]:
    """
    Open a cloud browser session, navigate to GoTonight, dismiss the modal,
    then fire jQuery AJAX POST to /Map/ReadEventViews.
    Returns a list of raw HTML card strings.
    """
    from browser_use import Browser

    is_today = "true" if date_str == DateClass.today().isoformat() else "false"

    url = (
        f"https://gotonight.com/?view=list"
        f"&date={date_str}"
        f"&latitude={lat}"
        f"&longitude={lon}"
        f"&zoom=12"
    )

    ajax_script = AJAX_SCRIPT_TEMPLATE.format(
        date=date_str,
        is_today=is_today,
        lat=lat,
        lon=lon,
        north=round(lat + DELTA, 4),
        west=round(lon - DELTA, 4),
        south=round(lat - DELTA, 4),
        east=round(lon + DELTA, 4),
    )

    browser = Browser(use_cloud=True)
    try:
        await browser.start()
        page = await browser.new_page(url=url)

        # ── Wait for jQuery to be available (poll up to 30s) ──────────────────
        jquery_ready = False
        for attempt in range(15):  # 15 × 2s = 30s max
            await asyncio.sleep(2)
            check = await page.evaluate("() => typeof window.$ !== 'undefined'")
            print(f"[music] jQuery check {attempt + 1}/15: {check}", flush=True)
            if check.lower() == "true":
                jquery_ready = True
                break

        if not jquery_ready:
            print("[music] ERROR: jQuery never became available after 30s.", flush=True)
            return []

        # Dismiss the cookie/promo modal if present
        await page.evaluate("""
        () => {
            const btns = Array.from(document.querySelectorAll('button'));
            const closeBtn = btns.find(b => b.textContent.trim() === 'Close');
            if (closeBtn && closeBtn.offsetParent !== null) closeBtn.click();
        }
        """)

        await asyncio.sleep(1)

        # ── Fire the AJAX request — retry up to 3 times if empty ─────────────
        MAX_RETRIES = 3
        for attempt in range(MAX_RETRIES):
            raw = await page.evaluate(ajax_script)
            result = json.loads(raw)

            if not result.get("success"):
                print(f"[music] AJAX error (attempt {attempt + 1}): {result.get('error')}", flush=True)
            else:
                events = result.get("data", {}).get("data") or []
                is_valid = result.get("data", {}).get("isRequestValid")
                print(f"[music] AJAX attempt {attempt + 1}: isRequestValid={is_valid}, events={len(events)}", flush=True)
                if events:
                    return events

            if attempt < MAX_RETRIES - 1:
                print(f"[music] Empty result — waiting 5s before retry...", flush=True)
                await asyncio.sleep(5)

        print("[music] All AJAX attempts returned empty. No events found.", flush=True)
        return []

    finally:
        await browser.close()



# ── HTML Parsing ───────────────────────────────────────────────────────────────

def parse_event_cards(html_cards: list[str]) -> dict[str, list[dict]]:
    """
    Parse each HTML event card (a profile-group block) into structured data.

    Structure of each card:
      - First `.profile.reverse` div  → venue info (name, location)
      - Subsequent `.profile` divs    → artist info (name, time)

    Returns a dict: { venue_name: [ { artist, time }, ... ] }
    """
    schedule = {}

    for html in html_cards:
        soup = BeautifulSoup(html, "html.parser")
        group = soup.find("div", class_="profile-group")
        if not group:
            continue

        profiles = group.find_all("div", class_="profile", recursive=False)
        venue_name = None
        artists = []

        for profile in profiles:
            classes = profile.get("class", [])
            is_venue = "reverse" in classes

            # Extract name — try <a> first, then <span>
            bold_div = profile.find("div", class_="fw-bold")
            name_tag = bold_div.find("a") if bold_div else None
            if not name_tag:
                name_tag = bold_div.find("span") if bold_div else None
            name = name_tag.get_text(strip=True) if name_tag else ""

            if is_venue:
                venue_name = name
            else:
                # Extract time from gt-fs-sm div
                time_div = profile.find("div", class_="gt-fs-sm")
                time_text = ""
                if time_div:
                    time_inner = time_div.find("div")
                    if time_inner:
                        time_text = time_inner.get_text(strip=True)

                if name:
                    artists.append({"artist": name, "time": time_text})

        if venue_name:
            if venue_name not in schedule:
                schedule[venue_name] = []
            schedule[venue_name].extend(artists)

    return schedule


# ── Output Formatter ───────────────────────────────────────────────────────────

def format_output(schedule: dict, location: str, date_str: str) -> str:
    """Format the schedule dict into the required markdown output."""
    if not schedule:
        return f"No live music schedules found on GoTonight for {location} on {date_str}."

    lines = [f"## Live Music Schedule for {location} ({date_str})", ""]

    for venue in sorted(schedule.keys()):
        lines.append(f"- **{venue}**")
        for entry in schedule[venue]:
            lines.append(f"  - **Artist:** {entry['artist']}")
            if entry["time"]:
                lines.append(f"  - **Time:** {entry['time']}")
        lines.append("")

    return "\n".join(lines).rstrip()


# ── Main ───────────────────────────────────────────────────────────────────────

async def main():
    date_str, location = parse_args()
    lat, lon, resolved_location = resolve_location(location)

    html_cards = await fetch_events(date_str, lat, lon)
    schedule = parse_event_cards(html_cards)
    output = format_output(schedule, resolved_location, date_str)
    print(output)


if __name__ == "__main__":
    asyncio.run(main())
