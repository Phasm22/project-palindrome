# Environment Variables Reference

This document lists every `process.env.*` the codebase reads (excluding tests and `.bak`), so you can compare against your `.env` and close gaps.

---

## Documented in CLAUDE.md

| Variable | Required? | Default / Note |
|----------|-----------|----------------|
| `OPENAI_API_KEY` | Yes (agent/RAG) | — |
| `NEO4J_URI` | Yes | `bolt://localhost:7687` |
| `NEO4J_USER` | Yes | `neo4j` |
| `NEO4J_PASSWORD` | Yes | `password` in code default |
| `QDRANT_URL` | Yes | `http://localhost:6333` |
| `PROXMOX_URL` | Optional | — |
| `PROXMOX_TOKEN_ID` | Optional | — |
| `PROXMOX_TOKEN_SECRET` | Optional | — |
| `OPNSENSE_URL` | Optional | — |
| `OPNSENSE_API_KEY` | Optional | — |
| `OPNSENSE_API_SECRET` | Optional | — |
| `ENABLE_LLM_INTENT_CLASSIFIER` | Optional | `true` to use LLM classifier |
| `INTENT_CLASSIFIER_MODEL` | Optional | `gpt-4o-mini` |
| `SSH_USER_<IP>`, `SSH_PASSWORD_<IP>` | Per-host SSH | — |

---

## Gaps: Used by code but not in CLAUDE.md

### Proxmox (VM/create/Terraform/ingestion)

Required or used when you run Proxmox/Terraform flows:

| Variable | Used when | Default in code |
|----------|-----------|------------------|
| `PROXMOX_URL` | Proxmox API, Terraform, ingestion | — |
| `PROXMOX_TOKEN_ID` | Proxmox API (some paths) | — |
| `PROXMOX_TOKEN_SECRET` | Proxmox API (some paths) | — |
| `CLUSTER_TF_TOKEN_ID` | Terraform / create-vm (cluster or proxbig) | — |
| `PROXMOX_CLUSTER_TF_SECRET` | Terraform cluster secret | — |
| `PROXMOX_YIN_TF_SECRET` | Terraform on yin | — |
| `PROXMOX_YANG_TF_SECRET` | Terraform on yang | — |
| `PROXMOX_PROXBIG_TF_SECRET` or `PROXBIG_TF_SECRET` or `PROXBIG_TOKEN_SECRET` | Terraform on proxbig | — |
| `PROXMOX_YIN_URL`, `PROXMOX_YANG_URL` | Per-node Proxmox URL | Falls back to `PROXMOX_URL` |
| `PROXMOX_YIN_TF_TOKEN_ID`, `PROXMOX_YANG_TF_TOKEN_ID` | Per-node token | Falls back to `CLUSTER_TF_TOKEN_ID` |
| `PROXMOX_VERIFY_SSL` | TLS verification | `"false"` to disable |
| `PROXBIG_TF_TOKEN_ID` | Proxbig Terraform | Fallback for token id |

### SSH (Terraform, SSHTool, create-vm)

| Variable | Used when | Default in code |
|----------|-----------|------------------|
| `SSH_PUBLIC_KEY` | Terraform, create-vm (injected keys) | Env validator warns if unset; create-vm uses `""` |
| `SSH_KEY_PATH` | SSHTool | `$HOME/.ssh/id_ed25519` |
| `SSH_USER` | SSHTool default user | `root` |
| `SSH_PASSWORD` | SSHTool password auth | — |
| `SSH_USER_<HOST>`, `SSH_PASSWORD_<HOST>` | Per-host SSH (see CLAUDE) | — |
| `SSH_AUTH_SOCK`, `SSH_AGENT_PID` | Terraform runner (forwarded to subprocess) | — |
| `HOME`, `USER` | Terraform key path fallback | — |

### OPNsense

| Variable | Used when | Default in code |
|----------|-----------|------------------|
| `OPNSENSE_URL` | OPNsense API / MCP | — |
| `OPNSENSE_API_KEY` | OPNsense API | — |
| `OPNSENSE_API_SECRET` | OPNsense API | — |
| `OPNSENSE_VERIFY_SSL` | TLS verification | `"false"` to disable |
| `OPNSENSE_SSH_HOST` | Readonly tool (SSH/pfctl) | `OPNsense.prox` |
| `MCP_OPNSENSE_COMMAND` | MCP Opnsense tool | `npx` |
| `MCP_OPNSENSE_ARGS` | MCP Opnsense tool (JSON) | — |

### Pi-hole (DNS/DHCP actions)

| Variable | Used when | Default in code |
|----------|-----------|------------------|
| `PIHOLE_URL` | create-dns-record, sync-dhcp-to-dns, pihole client | `http://piholelab.prox` |
| `PIHOLE_WEB_PWD` | Pi-hole auth | — |
| `PIHOLE_API_KEY` | Pi-hole API (legacy) | — |
| `PIHOLE_VERIFY_SSL` | Pi-hole client | `"true"` to enable |

### PCE / API / CLI

| Variable | Used when | Default in code |
|----------|-----------|------------------|
| `PCE_API_URL` | CLI, rag-client, config | `http://localhost:4000` |
| `PCE_API_PORT` | API server | `4000` |
| `PCE_USER_ID` | CLI / API user id | `cli-user` / `default-user` |
| `PCE_ACL_GROUP` | CLI / API ACL | `admin` / `viewer` |
| `PCE_USER_ACL_GROUP` | PCE CLI, ingestion | `admin` / `ops` |
| `PCE_STREAM` | CLI stream mode | `"true"` to enable |
| `PCE_AUTO_APPROVE_HIGH_RISK_TOOLS` | CLI / runner | `"true"` to skip confirm |
| `PCE_SNAPSHOT_LOG_PATH` | DLM snapshot log | `./.pce/snapshots.json` |
| `PCE_RAW_STORAGE_PATH` | DLM raw storage | `./.pce/raw-documents` |
| `PCE_COLLECTION_NAME` | Qdrant collection | `pce_documents` |
| `PCE_LOG_LEVEL` | PCE logger, utils logger | `DEBUG` for debug |
| `PCE_PROMPT_SUGGESTIONS_ENABLED` | Proxmox ingestion | `"false"` to disable |
| `PCE_PROMPT_SUGGESTIONS_LIMIT` | Proxmox ingestion | `6` |
| `PCE_INCIDENT_LOG_PATH` | CreateIncidentTicketTool | — |
| `PCE_EMBEDDING_MODEL` | Embeddings, debug-vector | `text-embedding-3-small` |

### Embeddings / LLM (optional providers)

| Variable | Used when | Default in code |
|----------|-----------|------------------|
| `EMBEDDINGS_PROVIDER` | Embeddings | `openai` |
| `PCE_EMBEDDING_MODEL` | OpenAI embeddings | `text-embedding-3-small` |
| `LOCAL_EMBED_MODEL` | Local embeddings | `nomic-embed-text` |
| `LLM_PROVIDER` | RAG generation, local-llm-service | `openai` |
| `LOCAL_LLM_MODEL` | Local LLM | `mistral:7b` |
| `OLLAMA_BASE_URL` | Embeddings / local LLM | `http://localhost:11434` |

### Other

| Variable | Used when | Default in code |
|----------|-----------|------------------|
| `ANSIBLE_DIR` | Ansible playbooks (bootstrap, configure-firewall, set-static-ip, install-nginx) | `lab-infra/ansible` |
| `DISABLE_RESPONSE_FORMATTING` | Response formatter | `"true"` to disable |
| `PROMPT_VERSION` | Runner | Hash-derived if unset |
| `AGENT_VERSION`, `GIT_SHA`, `COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA` | Runner version | — |
| `DEBUG` | Utils logger | — |
| `QDRANT_API_KEY` | Qdrant client | Optional |
| `OPNSENSE_HOSTNAME` | Network ingestion | `opnsense` |
| `PROMETHEUS_URL` | scripts/check-metrics | `http://localhost:9090` |

---

## Likely gaps if you only have CLAUDE.md + .env.example.local

- **Proxmox:** `CLUSTER_TF_TOKEN_ID` and one of the Terraform secrets (`PROXMOX_CLUSTER_TF_SECRET` or node-specific `PROXMOX_YIN_TF_SECRET` / `PROXMOX_YANG_TF_SECRET` / `PROXMOX_PROXBIG_TF_SECRET` or `PROXBIG_*`) if you use create-vm or Terraform.
- **SSH:** `SSH_PUBLIC_KEY` (env-validator warns; create-vm uses it for key injection).
- **OPNsense:** `OPNSENSE_SSH_HOST` if you use the readonly SSH/pfctl path (defaults to `OPNsense.prox`).
- **PCE:** `PCE_API_URL` if you run CLI against a non-local API; `PCE_USER_ID` / `PCE_ACL_GROUP` if you care about user/ACL.
- **Pi-hole:** `PIHOLE_URL`, `PIHOLE_WEB_PWD` (or `PIHOLE_API_KEY`) if you use DNS/DHCP actions.
- **Optional:** `ENABLE_LLM_INTENT_CLASSIFIER`, `INTENT_CLASSIFIER_MODEL` (documented in CLAUDE); `PCE_EMBEDDING_MODEL`, `EMBEDDINGS_PROVIDER`, `LLM_PROVIDER`, `OLLAMA_BASE_URL` if you use local embeddings/LLM.

`.env.example.local` only documents local GPU/Ollama and `OPENAI_API_KEY`; it does not list Proxmox, OPNsense, SSH, PCE, or Pi-hole. Use this reference to align your `.env` with the features you run.
