# Transcriptor - Automated Assembly Minutes Production System

## Project Overview
Transcriptor is a multi-agent system that automates the production of formal assembly minutes (Actas de Asamblea) for Colombian horizontal property events. It processes audio recordings, integrates electronic voting data, and produces professionally formatted Word documents compliant with Ley 675 de 2001.

## Agents
| Agent | Role | Function |
|-------|------|----------|
| Supervisor | Orchestrator | Tracks pipeline state, retries, notifications |
| Yulieth | Intake | Watches Google Drive, validates, queues jobs |
| Chucho | Audio Prep | Converts audio to optimal transcription format |
| Robinson | Data Layer | Single source of truth for voting/attendance data |
| Jaime | QA + Sectioning | Maps transcript to sections, flags errors |
| Lina | Redaction | Transforms speech into formal legal narrative |
| Fannery | Assembly | Builds final .docx from section files |
| Gloria | Review UI | Web interface for human review |

## Tech Stack
- Runtime: Node.js + TypeScript
- Queue: BullMQ + Redis
- Audio: FFmpeg via fluent-ffmpeg
- Transcription: ElevenLabs Scribe API
- LLM: Anthropic Claude API
- Document: docx npm package
- Storage: Google Drive API
- UI: React (Gloria)
- Monorepo: pnpm workspaces

## Naming Conventions
- Variables/functions/methods: camelCase
- File names: camelCase.ts
- Types/Interfaces: PascalCase
- Constants: UPPER_SNAKE_CASE
- Agent packages: lowercase (packages/yulieth/)
- Section files: snake_case with prefix (00_encabezado.json)
