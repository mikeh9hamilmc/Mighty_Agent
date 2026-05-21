import requests
from geopy.geocoders import Nominatim

def degrees_to_compass_8point(degrees):
    """Converts wind direction degrees into 8 cardinal/intercardinal points."""
    if degrees is None:
        return "N/A"
    
    # 8 distinct compass points spaced 45 degrees apart
    compass_brackets = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    
    # Scale degrees into an index from 0 to 7.
    # Adding 22.5 shifts the calculation to center around each 45-degree sector.
    index = int((degrees + 22.5) / 45) % 8
    return compass_brackets[index]

def get_weather(location_name="Redington Shores, FL"):
    # 1. Geocode the location text to Lat/Lon coordinates
    geolocator = Nominatim(user_agent="weather_agent_v1")
    location = geolocator.geocode(location_name)
    
    if not location:
        return f"Could not find coordinates for location: {location_name}"
        
    lat, lon = location.latitude, location.longitude
    
    # 2. Query Open-Meteo's endpoint
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": ["temperature_2m", "relative_humidity_2m", "wind_speed_10m", "wind_direction_10m"],
        "daily": ["precipitation_probability_max"],
        "timezone": "auto",
        "forecast_days": 1
    }
    
    response = requests.get(url, params=params).json()
    
    # 3. Extract metrics
    current = response.get("current", {})
    daily = response.get("daily", {})
    
    raw_wind_direction = current.get("wind_direction_10m")
    
    return {
        "location": location.address,
        "temperature_f": round((current.get("temperature_2m") * 9/5) + 32, 1), 
        "humidity_pct": current.get("relative_humidity_2m"),
        "wind_speed_mph": round(current.get("wind_speed_10m") * 0.621371, 1), 
        "wind_direction_cardinal": degrees_to_compass_8point(raw_wind_direction), # Updated to 8-point tracker
        "rain_probability_pct": daily.get("precipitation_probability_max", [0])[0]
    }

# Quick Test Execution
if __name__ == "__main__":
    print("--- Default Location Weather ---")
    data = get_weather()
    for key, val in data.items():
        print(f"{key}: {val}")