# Mighty Agent

A Node.js-based personal agent that uses Claude LLM to interpret natural language via Telegram and execute local Python scripts via modular skills.

## WSL Installation Guide

To install the agent on a new WSL (Ubuntu) machine, follow these steps:

### 1. Clone the repository
```bash
# If you are copying files manually, ensure the directory structure is preserved.
cd Mighty_Agent
```

### 2. Run the Install Script
Make the script executable and run it:
```bash
chmod +x install.sh
./install.sh
```
This script will:
- Install Node.js (v18) and Python3.
- Install all NPM and Python dependencies.
- Setup Playwright for web-scraping skills.
- Create an initial `.env` file.

### 3. Configure the Agent
Open the `.env` file and fill in your credentials:
```bash
nano .env
```
Required fields:
- `TELEGRAM_TOKEN`: Your bot token from @BotFather.
- `AUTHORIZED_USER_ID`: Your Telegram numeric ID.
- `ANTHROPIC_API_KEY`: Your Claude API key.

### 4. Start the Agent
```bash
npm start
```

## Running as a Background Service
If you want the agent to run automatically in the background:
1. Prepare the service file:
   ```bash
   envsubst < mighty-agent.service.template > mighty-agent.service
   ```
2. Link it to systemd:
   ```bash
   sudo cp mighty-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable mighty-agent
   sudo systemctl start mighty-agent
   ```

## Manual Python Usage
If you want to run Python scripts manually or install new packages into the environment, activate it using:
```bash
source venv/bin/activate
# Now you can run pip or python directly
deactivate
```

## Skills
The agent discovers skills dynamically from the `skills/` directory. Each skill is a folder containing a `SKILL.md` definition and a `scripts/` directory with a Python entry point.
