# Mighty Agent

A Node.js-based personal agent that uses Claude LLM to interpret natural language via Telegram and execute local Python scripts via modular skills.

## Core Architecture

The system is built as a modular Node.js application that bridges the gap between a chat interface (Telegram) and local system execution (Python), utilizing a skill-based architecture.

### Components

- **`src/index.js`**: The application entry point. It initializes the bot, starts the scheduler, and handles graceful shutdowns (SIGINT/SIGTERM).
- **`src/scheduler.js`**: Manages time-based tasks using `node-cron`.
- **`src/bot.js`**: Orchestrates the Telegram interaction using the `telegraf` library.
    - **Security Middleware**: Validates every incoming message against the `AUTHORIZED_USER_ID`. Unauthorized messages are silently ignored.
    - **Command Handlers**: Manages explicit commands like `/start`, `/list`, `/refresh`, `/status`, `/clear`, and individual commands for every enabled skill (e.g., `/dip_buy`).
    - **Natural Language Handler**: Routes all non-command text messages to the LLM layer.
- **`src/llm.js`**: Orchestrates the Main Agent using the OpenRouter API (`@preset/mighty-agent-main`).
    - **Agentic Loop**: Runs a tool-calling loop (up to 15 iterations) instead of a one-shot call.
    - **Document & Memory Access**: Uses `DocumentManager` to access `skills/main/data/` and `skills/main/memory/`, giving the main agent its own persistent context.
    - **Routing Tools**: `run_skill` (delegates to Python executor) and `ask_agent` (delegates to legal/medical/finance/coder/travel     sub-agents) are real tool calls in the loop.
    - **Skill Discovery**: Dynamically scans the `skills/` directory, excluding sub-agent folders (main/legal/medical/finance/coder/travel).
- **`src/executor.js`**: Handles the actual execution of Python scripts within skills.
    - **Resolution**: Dynamically resolves the entry-point script for a given skill.
    - **Security**: Sanitizes names and enforces path restrictions.
    - **Robustness**: Implements a configurable execution timeout and forces UTF-8 encoding for cross-platform compatibility.
- **`src/config.js`**: Centralized configuration and environment variable validation.
- **`src/logger.js`**: Structured logging using `winston`, writing to both the console and `logs/agent.log`.
- **`src/coder-agent.js`**: The **Coder sub-agent**. A local autonomous coding agent.
- **`src/legal-agent.js`**: The **Legal sub-agent**. Expert in Florida/Texas law and case document analysis.
- **`src/medical-agent.js`**: The **Medical sub-agent**. Specialized in medical research and record analysis.
- **`src/finance-agent.js`**: The **Finance sub-agent**. Senior strategist for investing (UPRO), real estate, and tax.
- **`src/travel-agent.js`**: The **Travel sub-agent**. Research specialist for flights, cruises, and destination guides via Kayak.

## Workflow

### User Agent Interaction

1.  **Input**: User sends a message to the Telegram bot.
2.  **Authentication**: The bot checks if the user's ID matches the `AUTHORIZED_USER_ID` in `.env`.
3.  **Analysis**:
    - If it's a command (e.g., `/dip_buy`), it goes straight to the Executor.
    - If it's text, it's sent to the LLM with the current skill manifest (names and descriptions).
4.  **Decision**: The LLM determines if this is a chat session or a skill execution request. If its a chat session, a new Session is started or continued and the `reply` is sent to the user. If its a skill execution request, a `run` action with a specific `skill` name and `args`.
5.  **Execution**: (If `run`) The Executor locates the script for the specified skill, spawns a Python child process, captures output, and monitors for timeouts.
6.  **Output**: The bot sends the chat response or the skill's output back to the user.

### Session

1. A new Session is started if no existing Session is found. A session timer is started at the time of creation and is reset each time a message is received.
2. A session stays active for 60 minutes after the last message.
3. During the session, the entire conversation history is sent to the LLM with each message. 
4. User may ask to remember key facts for this conversation and then write them to the agents memory folder.
5. User may ask to create a new file to store the entire conversation history for the active session. This file will be stored in the agents /data folder with .md extension.

### Memory

1. When the program is started or refreshed, the files in /main/memory folder should be read and included in the system prompt of the Main Agent or any Sub Agent.
2. When the user asks a sub agent for the first time in a session, the sub agent should read the memory files in its /sub agent/memory folder and include them in the system prompt of the sub agent.

### Data

1. When the program is started or refreshed: any new pdf, excel or word documents in all data folders should be converted to .md and included in the data cache.
2. If user asks about records, documents, or files, the agent that is being talked to should use tools to search its /data cache or .md files to find the information and include them in the reply to the user.

### Proactive Interactions
The agent can also initiate contact via the **Scheduler**. For example, it is configured to send a "Good morning" message every day in the morning automatically.

> [!NOTE]
> **Telegram UI Sync**: Telegram aggressively caches the bot's command menu on the client side. If you add a new skill or perform a `/refresh` and don't see the updated commands when typing `/`, you may need to completely close and restart your Telegram app (Desktop or Mobile) to force it to fetch the new menu.

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

### 2026-05-17
- **Skill Addition — `clear`**: Added a new native `clear` skill that immediately wipes the in-memory session context.
    - Added `/clear` as a native bot command in `src/bot.js` that calls `session.clear()` and replies *"🧹 Session cleared. Starting fresh!"*.
    - Registered `/clear` in the `systemCommands` array inside `syncTelegramCommands()` so it always appears in the Telegram slash menu.
    - Created `skills/clear/SKILL.md` so the main LLM router can match natural language requests like *"clear session"*, *"start fresh"*, or *"reset context"* to this skill.
    - Added `clear` entry to `skills/enabled_skills.json` (enabled by default).

### 2026-05-15
- **Dynamic Skill & Command Syncing**: Refactored `llm.js` to support live skill refreshing. The `/refresh` command now dynamically updates the Telegram slash menu to match `enabled_skills.json` without requiring a restart.
- **Telegram Visual Feedback**: Implemented a "typing..." status indicator in the Telegram header. The bot now displays the "three dots" thinking indicator during long-running agent reasoning and local tool execution.
- **Research Priority Optimization**: Updated system prompts for Travel, Legal, Medical, and Finance sub-agents to strictly prioritize local document research (`grep_documents`) over external web searches.
- **Factual Query Optimization**: Updated `isStatusCommand` regex across all sub-agents to prevent "how many" factual questions from being incorrectly intercepted as document status requests.
- **Automated Testing Suite**: Implemented a comprehensive Jest test suite (`tests/agent.test.js`) and a real-world simulation script (`test_main.js`) to verify session persistence, memory routing, and tool execution logic.
- **Cross-Platform PDF Support**: Resolved `pdftotext` missing errors on Windows by implementing `winget` installation logic and updating error messages to provide platform-specific instructions.
- **Telegram Message Reliability**: Fixed `MESSAGE_TOO_LONG` errors in the main agent by implementing message chunking for long conversational replies.
- **Repository Hygiene**: Standardized `.gitignore` patterns across all sub-agent directories to exclude research data and caches while preserving directory structure.
- **Coder Agent — Skill Discovery & Naming Fix**: Resolved an issue where the Coder sub-agent used the outdated `dip-buy` name due to hardcoded prompt examples.
    - Updated `SYSTEM_PROMPT` in `src/coder-agent.js` to use the correct `dip_buy` underscore convention.
    - Implemented `list_skills` tool to allow the Coder agent to programmatically discover all active skill folders.
    - Implemented `read_skill_file` tool to enable the agent to read source code from other skills for reference.

### 2026-05-12
- **Main Agent Refactor — Agentic Loop**: Refactored `llm.js` from a one-shot JSON router to a full agentic tool-calling loop.
    - Created `skills/main/data/` and `skills/main/memory/` for the main agent's own document and persistent memory storage.
    - Added document tools (`list_documents`, `grep_documents`, `view_document`) backed by `DocumentManager`.
    - Added memory tools (`save_memory`, `read_memory`, `list_memories`) with auto-injected `core_memory.md`.
    - Routing tools (`run_skill`, `ask_agent`) replace the fragile JSON-response pattern, making sub-agent delegation a true tool call.
    - Skill discovery now excludes sub-agent folders (`main/legal/medical/finance`) to avoid surfacing them as runnable Python skills.
- **Finance Agent — New Sub-Agent**: Implemented a specialized Finance sub-agent (`src/finance-agent.js`) for stock investing, real estate, and tax analysis.
    - Added prefix-based routing (`ask finance ...`) and automatic intent detection in the main LLM router.
    - Created `skills/finance/` directory structure with isolated data and memory storage.
    - Integrated sophisticated financial strategy guidelines (UPRO ETF, Real Estate CAGR analysis, CPA tax knowledge) into the system prompt.
- **Travel Agent — New Sub-Agent**: Implemented a specialized Travel sub-agent (`src/travel-agent.js`) using the `@preset/mighty-agent-travel` model.
    - Trained to research flights, cars, stays, and cruises via Kayak.
    - Integrated into the main agentic loop with automatic intent detection.
- **Global Memory & Refresh System**:
    - **Shared Memory**: Refactored `DocumentManager` to inject ALL `.md` files from the Main Agent's memory into all sub-agents.
    - **Global Memory Caching**: Implemented a module-level in-memory cache for global memory files in `src/document-tools.js`. Memory is loaded once per startup or refresh, eliminating redundant disk I/O.
    - **Global Memory Fallback**: Fixed `toolReadMemory` and `toolListMemories` to fall back to the main memory directory for sub-agents, ensuring cross-agent visibility of user facts.
    - **Native Refresh Command**: Replaced the `refresh` skill with a native `/refresh` bot command that triggers a system-wide `refreshAllManagers()` call.
- **Startup Optimization & Singleton Pattern**:
    - **Singleton DocumentManagers**: Refactored all agent modules to export their singleton `DocumentManager` instances.
    - **Pre-warming Fix**: Updated `src/index.js` to use these singleton instances for background cache warming, resolving a bug where duplicate instances caused double-initialization during refresh.
- **Telegram Interface & Command Refactoring**:
    - **Removed `/run` Command**: The generic `/run` command was removed in favor of dedicated commands for every skill.
    - **Dynamic Command Registration**: The bot now automatically registers a dedicated Telegram command for every enabled skill (e.g., `dip-buy` becomes `/dip_buy`).
    - **Telegram Menu Sync**: Implemented `syncTelegramCommands()` to programmatically update the Telegram "slash" menu via the `setMyCommands` API on every startup and refresh.
    - **List Stability**: Switched `/list` to HTML parse mode with automatic entity escaping to prevent Markdown parsing crashes from skill descriptions.
- **Skill Renaming & Consistency**:
    - **Underscore Migration**: Renamed all skill folders and internal name fields to use underscores instead of dashes for valid Telegram command syntax (e.g., `check-cash` -> `check_cash`).
    - **Logic Updates**: Updated `scheduler.js` and `check_upro.py` to reflect the new folder structure.
- **Trading Skill Enhancements (Dip-Buy & Check-UPRO)**:
    - **Purchase Ledger System**: Implemented a `purchase_ledger.json` system to track share age and tax lots.
    - **Tax Lot Awareness**: `check_upro` now displays a "Tax Lot Breakdown," calculating share age and flagging lots as "LONG TERM" (>1 year) or "SHORT TERM."
    - **Fill Reliability**: Increased the `execute_buy` timeout to 60 seconds and adjusted the limit price to `current_price - 0.10`.
    - **Security & Setup**: Added `.gitignore` rules for local trade configs and implemented `.example` file auto-initialization.
- **Legal Agent Refinement**: Updated the system prompt to prioritize recent, verified case law (1990–present) and prevent hallucinations.

### 2026-05-11
- **Medical Agent — OpenRouter Migration**: Migrated the Medical sub-agent from the direct Anthropic SDK to OpenRouter API using the `@preset/mighty-agent-medical` model.
    - Updated `medical-agent.js` to use `node-fetch` for API calls.
    - Converted all medical tools to OpenAI-compatible tool definitions (type: 'function').
    - Implemented a manual agentic loop with tool-call handling to replace the SDK's automatic streaming loop.
    - Updated `config.js` to support `OPENROUTER_API_KEY`.
- **Legal Agent — OpenRouter Migration**: Migrated the Legal sub-agent from the direct Anthropic SDK to OpenRouter API using the `@preset/mighty-agent-legal` model.
    - Updated `legal-agent.js` to use `node-fetch` for API calls.
    - Converted all legal tools to OpenAI-compatible tool definitions (type: 'function').
    - Implemented a manual agentic loop with tool-call handling.
- **Coder Agent — OpenRouter Migration**: Migrated the Coder sub-agent from the direct Anthropic SDK to OpenRouter API using the `@preset/mighty-agent-coder` model.
    - Updated `coder-agent.js` to use `node-fetch` for API calls.
    - Converted all coding tools to OpenAI-compatible tool definitions (type: 'function').
    - Implemented a manual agentic loop with tool-call handling.
- **Main Agent — OpenRouter Migration**: Migrated the Main LLM router from the direct Anthropic SDK to OpenRouter API using the `@preset/mighty-agent-main` model.
    - Updated `llm.js` to use `node-fetch` for API calls.
- **Skill Discovery - Legal & Medical**: Created `SKILL.md` files and standardized folder structures for `skills/legal/` and `skills/medical/`.
    - Added `data/` and `memory/` subdirectories to both skills.
    - Added `README.md` in data folders to guide user file placement.
    - This allows the main LLM router to discover these sub-agents as formal skills while maintaining their specialized "ask <agent>" routing.
- **Legal Agent Memory**: Implemented a persistent long-term memory system using a new `skills/legal/memory/` directory. Added `save_memory`, `read_memory`, and `list_memories` tools to allow the agent to autonomously record and recall strategic details.
- **Core Memory Auto-Injection**: Enabled automatic injection of the `core_memory.md` file into the Legal Agent's system prompt for instantaneous recall of case-critical facts without needing tool calls.
- **Routing Flexibility**: Enhanced the "ask <agent>" routing in `bot.js` to support punctuation and varying separators (e.g., `"ask legal,"`, `"ask legal:"`).
- **Caching Optimization**: Fixed a logging issue where `.md` and `.txt` files were incorrectly reported as "extracted" during startup; they are now correctly logged as "Loaded text" and categorized as cached.
- **Legal Agent Document Tools**: Added `create_document`, `edit_document`, and `convert_to_word` (pandoc) tools to the Legal sub-agent. The agent can now draft legal motions in Markdown and convert them to `.docx` files for the user.
- **Async Optimization**: Refactored `src/legal-tools.js` to use async `execFile` for PDF extraction and Word conversion. This prevents synchronous child processes from blocking the Node.js event loop during background tasks.
- **Scheduler Reliability (WSL2 Fix)**: Replaced `node-cron` with the `cron` package. This resolves the "missed execution" warnings and job skipping caused by WSL2 clock drift and `node-cron`'s fragile 1000ms threshold.
- **Error Handling**: Implemented `formatApiError` in `bot.js` to catch LLM API errors (like low credit balance or rate limits) and return user-friendly warnings instead of raw JSON errors.
- **Startup Cache Warming**: The bot now automatically initializes and warms the legal document cache in the background upon startup, ensuring the Legal agent is ready for immediate queries.
- **Finance Agent — New Sub-Agent**: Implemented a specialized Finance sub-agent (`src/finance-agent.js`) for stock investing, real estate, and tax analysis.
    - Added prefix-based routing (`ask finance ...`) and automatic intent detection in the main LLM router.
    - Created `skills/finance/` directory structure with isolated data and memory storage.
    - Integrated sophisticated financial strategy guidelines (UPRO ETF, Real Estate CAGR analysis, CPA tax knowledge) into the system prompt.

### 2026-05-10
- **Legal Agent Rewrite — Direct File Access**: Completely replaced the RAG pipeline (`rag-engine.js` + Voyage AI embeddings) with a tool-calling agentic loop. The legal sub-agent now has tools for listing, searching (grep), viewing, and creating/editing documents. This approach preserves table/financial data structure and handles OCR text far better than chunked embeddings.
- **New Module - `legal-tools.js`**: Created `src/legal-tools.js` — pure tool implementations for document lifecycle management. Uses `pdftotext -layout` (poppler-utils) for PDF text extraction, with mtime-based disk caching to `.legal-cache/`.
- **Removed - RAG Engine**: Deleted `src/rag-engine.js`. Removed `voyageai` and `pdf-parse` npm dependencies.
- **Kept**: DOCX support (`mammoth`), XLSX support (`xlsx`), Brave Search API, streaming responses, `ask legal` routing.

### 2026-05-09
- **Sub-Agent Addition - `legal-agent`**: Implemented a Legal sub-agent (`src/legal-agent.js`) powered by Claude Opus with expertise in Florida (Pinellas County) criminal, civil, and family law, and Texas Family Code §2.401 (informal marriage) and partition lawsuits.
- **Brave Search Integration**: Legal sub-agent uses the Brave Search API as a web-search fallback when the user's documents don't contain sufficient context.
- **Streaming Responses**: Legal answers are streamed back to Telegram via periodic message edits every 800ms, giving a live typing-indicator effect.
- **`ask <agent>` Routing**: Added prefix-based direct routing to sub-agents in `bot.js` (e.g., `"ask legal ..."`). LLM router also auto-detects legal intent for natural language queries.
- **New API Keys**: Added `BRAVE_API_KEY` to config and `.env.example`.
- **Skill Addition - `legal`**: Created `skills/legal/SKILL.md` so the legal sub-agent is discoverable by the main LLM router.

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
