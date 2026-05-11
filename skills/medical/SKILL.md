---
name: medical
description: A specialized medical sub-agent that can analyze medical records, lab results, and research health-related questions. Use for analyzing doctor reports, symptoms, or medication information.
license: MIT
metadata:
  author: indotraq-agent
  version: "1.0"
---

# medical

The medical skill provides access to an autonomous medical research assistant.

## Capabilities

- **Record Analysis**: Search and read through medical records and lab results in `skills/medical/data/`.
- **Health Research**: Search medical databases and health information via Brave Search.
- **Report Summarization**: Summarize complex medical reports into plain English.
- **Memory**: Remembers patient history and prior findings across sessions.

## Usage

You can invoke this skill by asking a medical question directly, or by prefixing your message with "ask medical: ".

**Example:**
"ask medical: explain these lab results from my last checkup"
"What are the common side effects of Lisinopril?"
