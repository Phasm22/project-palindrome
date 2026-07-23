# Agent Live VM Connection Test

- Timestamp: 2026-07-21T02:36:18.559Z
- Result: PASS (staged resume after verifier/planner fixes)
- Agent API user: live-agent-1784601302227
- Proxmox target: YANG
- Disposable VM: livecheck-mru12qbf
- Error: None. The first harness assertion rejected the valid wording "successfully destroyed"; the assertion now accepts both word orders.

## Phase timings

| Phase | Duration | Detail |
|---|---:|---|
| create + DNS/IP SSH verification | ~4.8m | Terraform clone, cloud-init, Pi-hole registration, and authenticated SSH checks completed; the run was preserved when the original nginx planner stalled. |
| nginx + verify HTTP | 49.13s | ServiceInstall \| service=nginx \| vm=livecheck-mru12qbf \| message=Nginx installed successfully on livecheck-mru12qbf.prox |
| confirmation | 3.03s | Confirmation requested for Destroy VM livecheck-mru12qbf on YANG. |
| destroy | 9.04s | VMDestroy \| node=YANG \| name=livecheck-mru12qbf \| vmid=9000 \| message=VM "livecheck-mru12qbf" (ID: 9000) has been succes |

## Verified ephemeral endpoints

- `ssh -p 22 ops@livecheck-mru12qbf.prox`
- `ssh -p 22 ops@172.16.0.93`
- `http://livecheck-mru12qbf.prox:80/`
- `http://172.16.0.93:80/`

The VM was destroyed after verification, so these test endpoints are intentionally no longer reachable.

## Operational observations

- Resumed the live lifecycle using the VM preserved after a stalled nginx planning turn.
- Authenticated SSH passed independently through both the authoritative DNS mapping and IP transport.
- Nginx returned a successful HTTP response independently through both DNS and IP URLs.
- Proxmox, Terraform state/config, and Pi-hole all report the disposable VM absent after agent destruction.
- Terraform clone/apply consistently took roughly 3.5 minutes; connection readiness brought the create turn to roughly 4.8 minutes.
- The first nginx turn stalled in unbounded plan generation. Planning is now bounded at 30 seconds and nginx/docker installs have a deterministic fast path.
- One ProxBig status read timed out at 30 seconds and delayed an otherwise unrelated YANG nginx turn.
- Every one-second message-history poll increments `usage_chat_opened`, producing about 60 false usage events per minute.
- The ingestion scheduler remained `already running` across multiple five-minute cycles and should have a timeout/watchdog.
- The host's systemd-resolved path times out for `.prox`; connection verification now queries the configured Pi-hole DNS server and validates transport against the resolved IP.
- Pi-hole also returns synthetic NAT64 AAAA records; the verifier now prefers native A records when present.
- Terraform targeted destroy includes `null_resource.ansible_inventory`; the normal safety gate refuses it. The isolated live run used the opt-in exact-name/node Proxmox recovery and then removed only matching state/config/DNS.
- VM create refresh pruned stale VM resource addresses for `porttest` and `tandonisgay` while their cloud-config state remained. The original tfvars entry was restored after the test; state reconciliation needs review.
- The configured `PROXMOX_YIN_URL` currently reaches the YANG endpoint; cluster reads work, but the configuration should be corrected.
- Existing Terraform state still contains stale cloud-config entries and historical VM-ID inconsistencies.
- Infrastructure turns require longer polling than the legacy 25-second agent API test timeout.

Secrets and public-key material are intentionally omitted.
