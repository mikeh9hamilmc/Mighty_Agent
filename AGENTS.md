# Mini OpenClaw Agent

A Node.js-based personal agent that uses Claude LLM to interpret natural language via Telegram and execute local Python scripts via modular skills.

## Core Architecture

The system is built as a modular Node.js application that bridges the gap between a chat interface (Telegram) and local system execution (Python), utilizing a skill-based architecture.

### Components

- **`src/index.js`**: The application entry point. It initializes the bot, starts the scheduler, and handles graceful shutdowns (SIGINT/SIGTERM).
- **`src/scheduler.js`**: Manages time-based tasks using `node-cron`. Currently configured to send a daily 9:00 AM greeting to the authorized user.
- **`src/bot.js`**: Orchestrates the Telegram interaction using the `telegraf` library.
    - **Security Middleware**: Validates every incoming message against the `AUTHORIZED_USER_ID`. Unauthorized messages are silently ignored.
    - **Command Handlers**: Manages explicit commands like `/start`, `/list`, `/run`, and `/status`.
    - **Natural Language Handler**: Routes all non-command text messages to the LLM layer.
- **`src/llm.js`**: Interfaces with the Anthropic Claude API (`claude-haiku-4-5`).
    - **Skill Discovery**: Dynamically scans the `skills/` directory and parses `SKILL.md` files to build the LLM's tool context.
    - **Decision Logic**: Claude decides whether to respond conversationally or to trigger a skill execution based on user intent.
- **`src/executor.js`**: Handles the actual execution of Python scripts within skills.
    - **Resolution**: Dynamically resolves the entry-point script for a given skill.
    - **Security**: Sanitizes names and enforces path restrictions.
    - **Robustness**: Implements a configurable execution timeout and forces UTF-8 encoding for cross-platform compatibility.
- **`src/config.js`**: Centralized configuration and environment variable validation.
- **`src/logger.js`**: Structured logging using `winston`, writing to both the console and `logs/agent.log`.
- **`src/coder-agent.js`**: The **Coder sub-agent**. A local autonomous coding agent powered by Claude Opus (`claude-opus-4-7`).
    - **Agentic Loop**: Runs up to 15 iterations, calling tools until the task is complete or no more tool calls are made.
    - **Tools**: `write_file`, `read_file`, `list_files`, `execute_python` — all sandboxed to the `skills/` directory.
    - **Skill Creation**: Can autonomously create new skills (SKILL.md + Python scripts), test them, and fix errors before reporting success.

## Workflow

1.  **Input**: User sends a message to the Telegram bot.
2.  **Authentication**: The bot checks if the user's ID matches the `AUTHORIZED_USER_ID` in `.env`.
3.  **Analysis**:
    - If it's a command (e.g., `/run date-time`), it goes straight to the Executor.
    - If it's text, it's sent to Claude with the current skill manifest (names and descriptions).
4.  **Decision**: Claude returns JSON indicating either a conversational `reply` or a `run` action with a specific `skill` name and `args`.
5.  **Execution**: (If `run`) The Executor locates the script for the specified skill, spawns a Python child process, captures output, and monitors for timeouts.
6.  **Output**: The bot sends the conversational response or the skill's output back to the user.

### Proactive Interactions
The agent can also initiate contact via the **Scheduler**. For example, it is configured to send a "Good morning" message every day at 9:00 AM automatically.

## Security & Safety

-   **User Locking**: Only one specific Telegram account can control the agent.
-   **Path Restriction**: Only scripts located within a skill's `scripts/` directory can be executed.
-   **Execution Guard**: Scripts are killed automatically if they exceed the `SCRIPT_TIMEOUT_SEC` limit.
-   **Sanitization**: Skill names and arguments are validated to prevent shell injection or directory climbing.

## Adding New Capabilities (Skills)

To add a new skill, follow the [AgentSkills specification](https://agentskills.io/specification):

1.  Create a folder in `skills/` (e.g., `skills/my-skill/`).
2.  Create a `SKILL.md` file in that folder with the required frontmatter:
    ```markdown
    ---
    name: my-skill
    description: A clear description of what this skill does for the LLM.
    ...
    ---
    ```
3.  Place your Python script(s) in `skills/my-skill/scripts/`. The executor will pick the first `.py` file it finds as the entry point.
4.  Restart the agent to allow it to discover the new skill.

## Change Log

### 2026-05-06
- **Deployment**: Created a comprehensive WSL installation package including `install.sh`, `requirements.txt`, and a systemd service template for easy deployment on remote Linux/WSL machines.
- **Skill Addition - `dip-buy`**: Integrated the UPRO dip-buying strategy as a formal agent skill, moving scripts into the modular architecture.
- **Skill Addition - `check-cash` & `check-upro`**: Added new skills for real-time monitoring of Interactive Brokers account cash balances and specific UPRO position status.
- **Enhanced `dip_buy_tracker.py`**: 
    - Fixed critical syntax errors and undefined variables in the core buying logic.
    - Implemented a `--silent` CLI flag to allow for quiet cron job execution while still reporting successful trades.
- **Repository Management**: Initialized local Git repository, configured user metadata (Michael Hamilton), and established the remote push to GitHub.
- **Documentation**: Comprehensive update to `README.md` covering remote installation, environment activation, and automated service management.
### 2026-05-07
- **Skill Refinement - `check-cash`**: Removed "Buying Power" from the `check_cash.py` script output to simplify account monitoring as per user request.
- **Skill Refinement - `check-upro`**: Enhanced the script to fetch and display the current UPRO price using `reqTickers`, including unrealized P&L calculation if a position exists.

### 2026-05-08
- **Fix - `scheduler`**: Reordered initialization in `index.js` to ensure the scheduler starts before the bot's blocking launch loop, resolving an issue where the morning greeting was not firing.
- **Skill Addition - `good-morning`**: Created a new composite skill that combines a personalized morning greeting with real-time weather data by re-using the `weather` skill logic.
- **Automation - `scheduler`**: Enhanced the scheduler to call the `good-morning` skill for daily greetings and added a weekday hourly automation for the `dip-buy` tracker.
- **Sub-Agent Addition - `coder-agent`**: Implemented a local Coder sub-agent (`src/coder-agent.js`) using Claude Opus (`claude-opus-4-7`). The main agent now routes coding/scripting tasks to the Coder, which autonomously writes, tests, and fixes Python skill code using an agentic tool loop.
