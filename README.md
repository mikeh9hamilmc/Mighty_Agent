# Mighty Agent

A modular, state-of-the-art personal assistant framework built on Node.js. It bridges the gap between conversational chat (via Telegram), structured system tool executions (via Python/Node), and domain-specific knowledge engines (via specialized sub-agents).

---

## Architecture & How It Works

The framework operates as an intelligent agentic routing loop. When a message is received in Telegram:
1. **Dynamic Command Registration**: The bot registers dedicated commands for every active skill (e.g., `/dip_buy`, `/check_cash`). Commands like `/start`, `/list`, `/refresh`, `/status`, and `/clear` are native system commands.
2. **Natural Language Processor (LLM Agentic Loop)**: Non-command text is analyzed by the Main Agent using **Gemini** (via OpenRouter). Instead of a one-shot response, it runs a tool-calling loop (up to 15 iterations) to execute local Python scripts (`run_skill`) or delegate to highly specialized sub-agents (`ask_agent`).
3. **Specialized Sub-Agents**: Independent sub-agents handle domain-specific workflows. Each possesses isolated knowledge files (`data/`), private long-term memories (`memory/`), and a highly tailored system prompt.

---

## Document & Memory Management (Critical Directories)

Each agent (including the Main Agent) manages its own workspace inside `skills/<agent_name>/`:

### 1. The `data/` Folder (Records & Documents)
* **Purpose**: Storing personal records, guidelines, receipts, reports, and source documents.
* **Supported formats**: `.pdf`, `.docx`, `.doc`, `.xlsx`, `.xls`, `.txt`, `.md`.
* **Behavior**: Any document dropped here is automatically parsed (with layout-preserving OCR support for PDFs) and cached. Sub-agents query these using direct document searching (`grep_documents`, `view_document`) to locate factual answers.
* **Commands to Agent**: Say *"create a file with this info"*, *"save to records"*, or *"store in my documents"*. The agent will reply: *"I noted that in your records."*

### 2. The `memory/` Folder (Persistent Core Memories)
* **Purpose**: Storing strategic insights, preferences, facts, and long-term user context.
* **Behavior**: Written to dynamically by the agent (`save_memory`) when learning critical facts or strategic rules. This folder is private context and not directly queryable as raw records, but it is automatically injected into the agent's system prompt.
* **Commands to Agent**: Say *"remember that..."* or *"make a note of..."*. The agent will reply: *"I noted that in my memory."*

---

## Active Specialized Sub-Agents

You can consult any specialized agent by asking naturally (the router automatically delegates) or explicitly routing using prefixes (`ask <agent_name>: <question>`):

| Prefix | Sub-Agent | Specialized Domain | Data Folder (`skills/...`) |
| :--- | :--- | :--- | :--- |
| **`ask legal`** | **Legal Agent** | expert in civil/family/criminal law, motion/contract drafting | `skills/legal/data/` |
| **`ask medical`** | **Medical Agent** | medical analysis, lab results, prescriptions, symptoms | `skills/medical/data/` |
| **`ask finance`** | **Finance Agent** | UPRO/ETF strategy, real estate CAGR, tax structures, CPA rules | `skills/finance/data/` |
| **`ask travel`** | **Travel Agent** | flight, stay, cruise, and destination itinerary research | `skills/travel/data/` |
| **`ask beauty`** | **Beauty Agent** | skincare routines, cosmetic chemistry, makeup, anti-aging (botox) | `skills/beauty/data/` |
| **`ask coder`** | **Coder Agent** | local autonomous software developer (writes and edits python scripts) | `skills/coder/data/` |

---

## Native Commands

* `/start` - Show welcoming menu.
* `/list` - Output descriptive table of all enabled skills and capabilities.
* `/clear` - Instantly wipe in-memory context and restart conversational session.
* `/status` - Verify system online status and uptime diagnostics.
* `/refresh` - Warm up all document caches, build caches, and dynamically synchronize the Telegram command slash-menu.

---

## Installation & Setup

### WSL (Ubuntu) / Linux Installation

1. **Clone & Enter Directory**:
   ```bash
   cd Mighty_Agent
   ```
2. **Execute Installer**:
   ```bash
   chmod +x install.sh
   ./install.sh
   ```
   *This automatically provisions Node.js, Python 3, NPM/Python packages, Playwright browser binaries, and Poppler OCR support (`pdftotext`).*

3. **Configure Settings**:
   Open `.env` and fill out authorization tokens:
   ```bash
   nano .env
   ```
   Required fields:
   * `TELEGRAM_TOKEN`: Bot token from @BotFather.
   * `AUTHORIZED_USER_ID`: Numeric Telegram ID of owner.
   * `OPENROUTER_API_KEY`: Key for LLM access.

4. **Run the Bot**:
   ```bash
   npm start
   ```

### Running as a Background Daemon
1. Build the systemd daemon script:
   ```bash
   envsubst < mighty-agent.service.template > mighty-agent.service
   ```
2. Link it to systemctl:
   ```bash
   sudo cp mighty-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable mighty-agent
   sudo systemctl start mighty-agent
   ```

---

## Developing New Skills

Mighty Agent adheres to the modular [AgentSkills specification](https://agentskills.io/specification). To add a capability:
1. Create a folder in `skills/` (e.g., `skills/my_new_skill/`).
2. Create a `SKILL.md` frontmatter definition mapping its usage rules.
3. Place Python scripts in `skills/my_new_skill/scripts/`. The framework automatically resolves the first `.py` file it detects.
4. Run `/refresh` in Telegram to register the new slash command in real-time.
