# Name: weather
# Description: Fetches real-time local weather data including temperature, humidity, wind, and precipitation probability for a specified location. Defaults to Redington Shores, FL if no location is provided.

## Goal
To quickly retrieve and format highly accurate, real-time weather metrics for the user's requested location, maintaining a clean fall-back location configuration.

## Input Processing Rules
1. **Location Parsing:** Inspect the user's input for a city, zip code, or region.
2. **Default Fallback:** If the user does not specify a location, or if the intent is vague (e.g., "What's the weather like today?"), automatically use **Redington Shores, FL** as the target location.

## Step-by-Step Execution Workflow
1. Identify the target location using the Input Processing Rules.
2. Use the python script called weather.py to get the weather data for the identified location.
3. Extract the following mandatory metrics:
   - Current Temperature
   - Humidity percentage
   - Wind speed
   - Wind direction
   - Percentage rain today

## Output Constraints & Formatting
Do not output dense walls of text. Present the data immediately using a clean, scannable Markdown layout. Use the exact structure below:

### Current Weather: [Insert Location Name]
> **Quick Summary:** [1-sentence description of current conditions, e.g., "Clear skies with a heavy sea breeze."]

| Metric | Current Condition |
| :--- | :--- |
| **Temperature** | [Value]°F / [Value]°C |
| **Humidity** | [Value]% |
| **Wind Speed** | [Value] mph / km/h |
| **Wind Direction** | [Direction, e.g., ENE] |
| **Rain Probability** | [Value]% chance of rain today |

*Ensure all units are clearly labeled and up-to-date.*