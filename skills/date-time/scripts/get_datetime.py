#!/usr/bin/env python3
"""
date-time skill — get_datetime.py
Returns the current local date and time in a human-readable format.
"""

from datetime import datetime

def main():
    now = datetime.now()
    # Primary line: ISO-style datetime
    iso_str = now.strftime("%Y-%m-%d %H:%M:%S")
    # Secondary line: friendly long format
    friendly_str = now.strftime("%A, %d %B %Y")
    print(f"{iso_str}  ({friendly_str})")

if __name__ == "__main__":
    main()
