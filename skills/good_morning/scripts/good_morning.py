#!/usr/bin/env python3
import sys
import subprocess
import os

# Force UTF-8 output so emoji prints correctly on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def get_weather():
    # Resolve path to the weather skill script
    # Current script is in skills/good-morning/scripts/
    # Target script is in skills/weather/scripts/get_weather.py
    current_dir = os.path.dirname(os.path.abspath(__file__))
    weather_script = os.path.abspath(os.path.join(current_dir, '..', '..', 'weather', 'scripts', 'get_weather.py'))
    
    if not os.path.exists(weather_script):
        return "❌ Error: Could not find weather script."

    try:
        # Run the weather script and capture output
        result = subprocess.run(
            [sys.executable, weather_script],
            capture_output=True,
            text=True,
            encoding='utf-8'
        )
        return result.stdout.strip()
    except Exception as e:
        return f"❌ Error executing weather script: {e}"

def main():
    greeting = "☀️ Good morning! I hope you have a great day. I am ready to help if you need anything."
    
    weather_report = get_weather()
    
    print(greeting)
    print("\n" + weather_report)

if __name__ == "__main__":
    main()
