Try to use the OpenAI developer documentation MCP server if you need to work with the OpenAI API, ChatGPT Apps SDK, Codex,… without me having to explicitly ask.

# Repository Guidelines

## Project Structure & Module Organization
- `src/`: core TypeScript code for the agent, tools, parsers, reasoning, and PCE services (`src/agent/`, `src/tools/`, `src/pce/`, `src/actions/`).
- `tests/`: Bun test suites organized by domain (`tests/tools/`, `tests/pce/`, `tests/flows/`, `tests/reasoning/`).
- `dashboard/`: frontend assets, JS modules, CSS, and local dashboard server.
- `scripts/`: operational and validation scripts (ingestion, service startup, infra checks).
- `docs/`: setup, architecture, API references, and operational runbooks.
- `lab-infra/`: Terraform + Ansible automation for homelab infrastructure.

## Build, Test, and Development Commands
- `bun install`: install dependencies.
- `bun run dev` or `bun run agent`: run the CLI agent locally.
- `bun test --bail`: run all tests (same default behavior as CI).
- `bun run --bun tsc --noEmit`: run TypeScript type checks.
- `bun run pce:api`: start the PCE API service.
- `bun run services:start` / `bun run services:stop`: start or stop local Docker-backed services.
- `bun run dashboard:serve`: run the dashboard server.
- `bun run dashboard:build`: rebuild minified Tailwind CSS for dashboard UI.

## Coding Style & Naming Conventions
- Language: TypeScript (ES modules), strict compiler settings in `tsconfig.json`.
- Formatting: follow existing style in `src/` and `tests/` (2-space indentation, semicolons, double quotes).
- File naming: kebab-case for modules (example: `tool-executor.ts`); tests end in `.test.ts`.
- Keep modules focused by domain (tool logic in `src/tools/`, parsing in `src/parsers/`, orchestration in `src/agent/`).

## Testing Guidelines
- Framework: Bun test runner (`import { describe, test, expect } from "bun:test"`).
- Name tests by behavior, and colocate by feature area under `tests/`.
- Some integration tests rely on Neo4j/Qdrant or env vars and may skip when unavailable; prefer explicit guards over brittle failures.
- Run `bun test --bail` before opening a PR.

## Commit & Pull Request Guidelines
- Commit style in history is short, imperative, and scoped (for example: `Fix VM-by-IP CIDR logic`, `Update dashboard layout`).
- Keep commits logically grouped; avoid mixing unrelated refactors and behavior changes.
- PRs should include: purpose, key changes, test evidence (command + result), and any config/env impacts.
- For UI/dashboard changes, attach screenshots or short recordings.
