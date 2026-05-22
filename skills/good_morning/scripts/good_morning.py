#!/usr/bin/env python3
import sys
import os

# Force UTF-8 output so emoji prints correctly on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def get_weather():
    # Resolve path to the weather skill script and import it as a module
    # Current script is in skills/good_morning/scripts/
    # Target script is in skills/weather/scripts/weather.py
    current_dir = os.path.dirname(os.path.abspath(__file__))
    weather_scripts_dir = os.path.abspath(os.path.join(current_dir, '..', '..', 'weather', 'scripts'))
    weather_script = os.path.join(weather_scripts_dir, 'weather.py')

    if not os.path.exists(weather_script):
        return "❌ Error: Could not find weather script at: " + weather_script

    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location('weather', weather_script)
        weather_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(weather_mod)

        data = weather_mod.get_weather()
        if isinstance(data, str):
            return data  # error message from the weather module

        return (
            f"🌡️ *Weather — {data['location']}*\n"
            f"Temperature: {data['temperature_f']}°F\n"
            f"Humidity: {data['humidity_pct']}%\n"
            f"Wind: {data['wind_speed_mph']} mph {data['wind_direction_cardinal']}\n"
            f"Rain chance: {data['rain_probability_pct']}%"
        )
    except Exception as e:
        return f"❌ Error fetching weather: {e}"

def main():
    greeting = "☀️ Good morning! I hope you have a great day. I am ready to help if you need anything."

    weather_report = get_weather()

    print(greeting)
    print("\n" + weather_report)

if __name__ == "__main__":
    main()
