# Mighty Agent — Sub-Agent Implementation Template & Guide

Use this document as a definitive step-by-step checklist and code template whenever you need to add a new specialized sub-agent (e.g. `legal`, `medical`, `finance`, `travel`, `beauty`, `coder`, or a new domain) to the Mighty Agent architecture.

---

## High-Level Implementation Steps

1. [ ] **Folder Structure**: Establish isolated data/memory storage inside `skills/`.
2. [ ] **Sub-Agent Script (`src/<name>-agent.js`)**: Create the dedicated sub-agent runner with OpenRouter API preset and document tools.
3. [ ] **Main LLM Routing Schema (`src/llm.js`)**: Register the new sub-agent for natural language delegation and exclude it from the dynamic Python skills scanner.
4. [ ] **Telegram Interception & Handler (`src/bot.js`)**: Match commands/prefixes (e.g. `ask <name>: ...`) and handle tool delegation streaming.
5. [ ] **Bot Cache Pre-warming (`src/index.js`)**: Initialize and warm the sub-agent's DocumentManager singleton at boot.
6. [ ] **Verification**: Run diagnostic tests to verify isolated routing, prompt compliance, and file creation.

---

## Detailed Walkthrough & Code Checklists

### 1. Folder Structure setup
Create a folder inside `skills/` named exactly after your sub-agent (using lowercase and underscores, e.g. `skills/real_estate/`). Set up the following structure:
```text
skills/<name>/
├── SKILL.md
├── data/
│   └── README.md (Brief user guide explaining what reference files to put here)
└── memory/
```

#### `skills/<name>/SKILL.md` Boilerplate:
```markdown
---
name: <name>
description: Sub-agent specializing in <domain_details>. Do not call directly as a Python script.
---
# <Agent Name> Agent
Specialized sub-agent workspace.
```

---

### 2. Create the Sub-Agent Script (`src/<name>-agent.js`)
Create a new file `src/<name>-agent.js`. Copy and modify this boilerplate:

```javascript
'use strict';

const fetch = require('node-fetch');
const { OPENROUTER_API_KEY } = require('./config');
const logger = require('./logger');
const { DocumentManager } = require('./document-tools');
const path = require('path');

// Singleton DocumentManager for this agent
const manager = new DocumentManager(
  path.join(__dirname, '../skills/<name>/data'),
  path.join(__dirname, '../skills/<name>/memory')
);

// Map local tools to the DocumentManager singleton
const tools = {
  list_documents: () => manager.listDocuments(),
  grep_documents: ({ query }) => manager.grepDocuments(query),
  view_document: ({ name }) => manager.viewDocument(name),
  create_document: ({ name, content }) => manager.createDocument(name, content),
  edit_document: ({ name, content }) => manager.editDocument(name, content),
  save_memory: ({ key, fact }) => manager.saveMemory(key, fact),
  read_memory: ({ key }) => manager.readMemory(key),
  list_memories: () => manager.listMemories()
};

// Define standard OpenAI/OpenRouter tools
const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'list_documents',
      description: 'List files in your isolated data folder (skills/<name>/data/).'
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep_documents',
      description: 'Find exact string matches in documents.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view_document',
      description: 'View the contents of a specific document.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Filename' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_document',
      description: 'Create a new text/markdown file in the records folder. Must say: "I noted that in your records" in the final output when used.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Filename ending in .md' },
          content: { type: 'string', description: 'Content to write' }
        },
        required: ['name', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_document',
      description: 'Overwrite content of an existing record file.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Filename' },
          content: { type: 'string', description: 'New contents' }
        },
        required: ['name', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save private facts/rules to long-term memory. Must say: "I noted that in my memory" in the final output when used.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key (snake_case, e.g. user_preference)' },
          fact: { type: 'string', description: 'Fact to store' }
        },
        required: ['key', 'fact']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description: 'Retrieve a stored memory value by its key.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Stored key' } },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_memories',
      description: 'List all memory keys and values currently stored.'
    }
  }
];

const SYSTEM_PROMPT = `You are an expert <name> consultant.
You specialize in:
- <expertise_point_1>
- <expertise_point_2>

### DOCUMENT SEARCH PRIORITY:
1. Always prioritize local research. Look at available files using list_documents and search them using grep_documents before claiming you do not know.
2. If the answer cannot be found in local files, fallback on your general knowledge.

### MEMORY & RECORDS DISAMBIGUATION RULES:
- When using 'create_document' or 'edit_document' to save raw documents or records, you MUST reply: "I noted that in your records".
- When using 'save_memory' to record facts, rules, or preferences, you MUST reply: "I noted that in my memory".
- Never mix up these terms.
`;

/**
 * Executes a question against the sub-agent via OpenRouter and yields intermediate chunks.
 * @param {string} task - The request to resolve.
 * @param {string} history - Prior session history context.
 * @param {function} onChunk - Callback for incremental text streams.
 */
async function runAgent(task, history, onChunk) {
  let messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `[Conversation History]\n${history || 'None'}\n\n[Current Task]\n${task}` }
  ];

  // Auto-inject core memory files if available
  const coreMem = manager.getCoreMemory();
  if (coreMem) {
    messages.splice(1, 0, { role: 'system', content: `[Core Memory Injection]\n${coreMem}` });
  }

  let finalOutput = '';
  const maxIterations = 10;

  for (let iter = 1; iter <= maxIterations; iter++) {
    logger.info(`[<AgentName>] Iteration ${iter}/${maxIterations}`);

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: '@preset/mighty-agent-<name>', // Change to target preset
        messages,
        tools: toolDefinitions
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`OpenRouter API error: ${res.status} - ${errorText}`);
    }

    const data = await res.json();
    const message = data.choices[0].message;

    if (message.content) {
      finalOutput += message.content;
      onChunk(message.content);
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      messages.push(message);

      for (const call of message.tool_calls) {
        const toolName = call.function.name;
        const toolArgs = JSON.parse(call.function.arguments || '{}');
        logger.info(`[<AgentName>] Tool call: ${toolName} ${JSON.stringify(toolArgs)}`);

        let result;
        if (tools[toolName]) {
          try {
            result = await tools[toolName](toolArgs);
          } catch (err) {
            result = `Error: ${err.message}`;
          }
        } else {
          result = `Error: Tool "${toolName}" not implemented.`;
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: toolName,
          content: typeof result === 'object' ? JSON.stringify(result) : String(result)
        });
      }
    } else {
      break; // End of loop
    }
  }
}

module.exports = {
  runAgent,
  manager
};
```

---

### 3. Setup Main LLM Routing (`src/llm.js`)

You must perform three edits inside `src/llm.js` to register the agent:

#### Edit 3a: Exclude the sub-agent from the dynamic Python skills scanner
Find `const AGENT_FOLDERS = new Set([...]);` inside `loadSkills()` and add your new agent's folder name so it isn't listed under standard executable skills:
```javascript
// Before: const AGENT_FOLDERS = new Set(['legal', 'medical', 'finance', 'main', 'coder', 'travel', 'refresh', 'beauty']);
const AGENT_FOLDERS = new Set(['legal', 'medical', 'finance', 'main', 'coder', 'travel', 'refresh', 'beauty', '<name>']);
```

#### Edit 3b: Update `ask_agent` JSON Schema
Locate the tool declaration schema for `ask_agent` inside `SYSTEM_PROMPT` or tool definitions. Update the enum to include the new sub-agent:
```json
"agent": {
  "type": "string",
  "enum": ["legal", "medical", "finance", "coder", "travel", "beauty", "<name>"],
  "description": "Select the specialized sub-agent to invoke."
}
```

#### Edit 3c: Map the Tool Callback Mapping
Locate the `agentMap` inside the `if (name === 'ask_agent')` tool block. Add your new agent:
```javascript
const agentMap = { 
  legal: 'legal', 
  medical: 'medical', 
  finance: 'finance', 
  coder: 'coder', 
  travel: 'travel', 
  beauty: 'beauty',
  <name>: '<name>'
};
```

---

### 4. Setup Telegram Interception (`src/bot.js`)

Make these updates in `src/bot.js`:

#### Edit 4a: Import your agent's runner at the top of the file
```javascript
const { runAgent: run<AgentName>Agent, manager: <name>Tools } = require('./<name>-agent');
```

#### Edit 4b: Register the agent in the `subAgents` registry mapping
Locate the `subAgents` dictionary near the top of the file and register the runner:
```javascript
const subAgents = {
  legal: runLegalAgent,
  medical: runMedicalAgent,
  finance: runFinanceAgent,
  travel: runTravelAgent,
  beauty: runBeautyAgent,
  <name>: run<AgentName>Agent
};
```

#### Edit 4c: Add prefix routing match
Locate the natural language handler where regex parses prefixes (e.g. `ask legal`). Update the regex or include your new prefix in the matching logic:
```javascript
// Find prefix-based matcher and add your prefix:
const prefixMatch = text.match(/^(?:ask\s+)?(legal|medical|finance|travel|beauty|<name>)\b\s*[,:]?\s*(.*)$/i);
```

#### Edit 4d: Add delegation decision block inside the LLM reply handler
Locate the block of checks for `decision.type` in the main text handler. Add your agent's delegation handler:
```javascript
// type === '<name>' — delegate to <AgentName> sub-agent
if (decision.type === '<name>') {
  await ctx.telegram.editMessageText(
    ctx.chat.id, thinking.message_id, undefined,
    '🔮 <AgentName> is thinking...'
  );
  streamAgentResponse(ctx, thinking.message_id, decision.task, '<name>').catch(err => {
    logger.error(`[<AgentName>] Background stream error: ${err.message}`);
    ctx.reply(`❌ <AgentName> agent error: ${err.message}`).catch(() => { });
  });
  return;
}
```

---

### 5. Bot Startup Cache Pre-warming (`src/index.js`)

To prevent delayed startup response times, pre-warm the document cache at bot initialisation.

#### Edit 5a: Import and register pre-warming logic
Open `src/index.js` and edit the warming block to import the tools and add it to `refreshAllManagers()`:
```javascript
const { manager: <name>Tools } = require('./<name>-agent');

// Inside refreshAllManagers():
async function refreshAllManagers() {
  // ...
  await Promise.all([
    // ...
    <name>Tools.initialize()
  ]);
}
```

---

## 6. Verification Plan

Ensure the new agent operates perfectly:
1. **No-Error Boot**: Run `npm start` and verify that the warming cycle completes cleanly with no warnings or missing dependencies.
2. **Dynamic Menu Excluder**: Run `/list` inside Telegram. Verify your new agent name does *not* appear as a runnable Python skill.
3. **Command Prefix Match**: Send `"ask <name>: Hello"` in Telegram and verify that it matches, turns into `"🔮 <AgentName> is thinking..."` and streams back successfully.
4. **Natural Language Routing**: Send a topic-specific query to the Main Agent (e.g. if routing real estate, ask: *"How is my condo property value calculated?"*). Verify that the main agent's tool loop triggers `ask_agent` for `<name>` and routes cleanly without falling through or throwing length errors.
5. **Memory and Record Verification**: Verify that commands to save documents or save facts correctly trigger the corresponding responses (*"I noted that in your records"* vs. *"I noted that in my memory"*).
