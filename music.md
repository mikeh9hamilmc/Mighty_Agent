# NAME: music
# DESCRIPTION: Fetches and compiles live music schedules for a specified location and date by dynamically scraping GoTonight.

[CORE CONFIGURATION]
- Inputs:
  - `location` (Optional[String]): The city, town, or venue area to search. 
  - `date` (Optional[String]): The date of the performances in YYYY-MM-DD format.
- Context Defaults (Current Epoch: 2026):
  - If `location` is null or unspecified, default to: "Redington Shores, FL" (Latitude: 27.8406, Longitude: -82.8315)
  - If `date` is null or unspecified, default to: Today's date (2026-05-21)

[EXECUTION WORKFLOW]

STEP 1: Geolocation Resolution
- If the location is the default "Redington Shores, FL", use coordinates:
  - Latitude: 27.76683788325855
  - Longitude: -82.7759104451111
- If a custom `location` is provided, use the Geocoding API/tool to resolve the location name into its precise geographic coordinates (`latitude` and `longitude`).

STEP 2: URL Construction
Construct a target URL for the GoTonight API/web interface using the following exact structure, dynamically replacing the query parameters based on Step 1 and the input date:
URL Template: https://gotonight.com/?view=list&date=[DATE]&latitude=[LATITUDE]&longitude=[LONGITUDE]&zoom=12

Example Default URL (Redington Shores, Today):
https://gotonight.com/?view=list&date=2026-05-22&latitude=27.76683788325855&longitude=-82.7759104451111&zoom=12 

STEP 3: Data Fetching & Extraction
- Deploy the web-browsing/scraping tool to the constructed URL.
- Parse the resulting venue list and schedule grid.
- Extract the following data points for each entry:
  - Venue Name
  - Artist/Band Name
  - Performance Time (Start/End)

[OUTPUT FORMAT]
Present the findings to the user in a clean, markdown-formatted list grouped by venue, sorted alphabetically:

## Live Music Schedule for [RESOLVED LOCATION] ([RESOLVED DATE])

- **[Venue Name 1]**
  - **Artist:** [Artist Name]
  - **Time:** [Time]

- **[Venue Name 2]**
  - **Artist:** [Artist Name]
  - **Time:** [Time]

If no live music is found or scheduled for that parameters, return: "No live music schedules found on GoTonight for [Location] on [Date]."