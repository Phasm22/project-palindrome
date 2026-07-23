# Dashboard Formatter Fixture Inventory

Target: snapshot the current dashboard chat rendering behavior before P1.3 changes `formatAgentResponse()` in `dashboard/js/chat.js`.

## Scope

- Pure formatter surface: `formatAgentResponse()` in `dashboard/js/chat.js`.
- Confirmation UI is not produced by `formatAgentResponse()`. It is appended by the `agent:final` render envelope when `confirmationRequired` is true. Snapshot that envelope separately because it is part of the same visible assistant message.

## Recommended Snapshot Split

1. Pure `formatAgentResponse(text)` fixtures.
2. One `agent:final` envelope fixture for confirmation metadata.

## Fixture Inventory

### 1. Clarification Prompt

Source branch: clarification detection + `formatClarificationMessage()`.

Fixture input:

```text
🔍 I found similar matches for "yan".
Did you mean one of these?
1. YANG
2. yin
Reply with the number or click an option.
❓ Unknown entity: yan
```

Expected rendered fragment / behavior:

- Wrapper includes `class="clarification-message"` and `data-clarification-text="..."`.
- First line renders as the blue search row, not a normal paragraph.
- `1. YANG` and `2. yin` render as clickable `<button>` options with `data-clarification-option-id`.
- `Reply with...` renders as muted italic help text.
- `❓ Unknown entity: yan` renders as an amber warning row.

### 2. Confirmation Prompt Envelope

Source branch: `agent:final` confirmation append, not `formatAgentResponse()` itself.

Fixture input:

```json
{
  "text": "VM Operation\nStatus: pending | Operation: destroy | VM: sentinelZero | Node: yin",
  "confirmationRequired": true,
  "confirmationId": "deadbeef",
  "confirmationPreview": "Destroy VM sentinelZero on yin. This cannot be undone."
}
```

Expected rendered fragment / behavior:

- The `text` portion renders as an operation status card with title `VM Operation`.
- A separate `Pending Change` box is appended below the formatted text.
- The preview text is visible verbatim.
- Two buttons render in the confirmation box: `Confirm` and `Cancel`.
- Buttons are wired with the escaped confirmation id via `window.handleConfirmAction("deadbeef", ...)` and `window.handleCancelAction("deadbeef", ...)`.

### 3. Canonical Terse Data List

Source branch: canonical entity-list contract.

Fixture input:

```text
Allowed Ports:
- SSH | port=22 | proto=TCP | source=home_network
- HTTPS | port=443 | proto=TCP | source=home_network
```

Expected rendered fragment / behavior:

- `Allowed Ports` renders as an orange `<h3>`.
- Each `- ... | key=value` line renders as a `.kv-card`.
- Card pills are `SSH` and `HTTPS`.
- Each card shows `port`, `proto`, and `source` rows in the key/value grid.

### 4. Firewall Rules Pipe-KV List

Source branch: generic pipe-KV line parser.

Fixture input:

```text
Firewall Rules
ALLOW | dir=in | src=192.168.68.0/22 | dst=lab_network | proto=TCP | port=22
BLOCK | dir=in | src=any | dst=lab_network | proto=any | if=wan
```

Expected rendered fragment / behavior:

- `Firewall Rules` renders as a normal paragraph, not an `<h3>`, because there is no trailing `:`.
- `ALLOW ...` and `BLOCK ...` render as separate `.kv-card` blocks.
- The pill labels are `ALLOW` and `BLOCK`.
- Rule fields render as grid rows: `dir`, `src`, `dst`, `proto`, `port` or `if`.

### 5. VM Inventory, Multiline Canonical Shape

Source branch: VM inventory heading + multiline VM entry parser.

Fixture input:

```text
VMs on node yin:
- sentinelZero (VM, running)
  - Details: node=yin | trace=compute-vm:yin:200
  - Source: Digital twin (Proxmox ingest); agent status unknown
- ubuntu-cloud-template (VM, stopped)
  - Details: node=yin | trace=compute-vm:yin:8001
  - Source: Digital twin (Proxmox ingest); agent status unknown
```

Expected rendered fragment / behavior:

- The section renders as the VM grid/table view, not as paragraphs.
- Table header shows `Name`, `Type`, `Status`, `Node`.
- `sentinelZero` and `ubuntu-cloud-template` render as separate VM rows.
- `running` uses the green status dot; `stopped` uses the red status dot.
- Node column shows `yin`.
- `trace` and `Source` are parsed but not currently rendered in the row UI.

### 6. VM Inventory, Inline Row Shape

Source branch: inline `| Status: ... | Node: ...` VM parsing.

Fixture input:

```text
LXC Containers
- PvVPN-Home | Status: running | Node: YANG | Trace: compute-vm:yang:103
- homebridge | Status: running | Node: YANG | Trace: compute-vm:yang:100
```

Expected rendered fragment / behavior:

- The section renders in the same VM grid/table layout.
- Type pill shows `LXC` for each row.
- Both rows show status `running` and node `YANG`.
- Inline `Trace:` is consumed during parsing but is not displayed in the rendered row.

### 7. Cluster Nodes Section

Source branch: cluster node section parser + `formatClusterNodesSection()`.

Fixture input:

```text
Cluster Nodes:
- yin
id
compute-node:yin
vms
2
status
online
- yang
id
compute-node:yang
vms
4
status
offline
```

Expected rendered fragment / behavior:

- Section renders as the node grid/table view.
- Table header shows `Node`, `VMs`, `Status`, `ID`.
- `yin` shows `2 VMs` and `yang` shows `4 VMs`.
- `online` uses the green status dot; `offline` uses the red status dot.
- The `id` value renders in `<code>` styling.

### 8. Key/Value Block With Copyable SSH Command

Source branch: key/value block parser + `formatMessageValue()`.

Fixture input:

```text
Success
status
completed
message
VM created successfully. Connect with: ssh ubuntu@10.0.0.50.
```

Expected rendered fragment / behavior:

- Entire response renders as a single `.kv-card` with pill `Success`.
- `status` row shows `completed`.
- `message` row shows the normal text plus a `Connect with:` sub-section.
- SSH command renders inside `<code>ssh ubuntu@10.0.0.50</code>`.
- A `Copy` button is present with `data-copyable="ssh ubuntu@10.0.0.50"`.

### 9. Operation Summary Card

Source branch: pipe-colon summary parser.

Fixture input:

```text
VM Operation
Status: running | Operation: start | VM: sentinelZero | Node: yin
```

Expected rendered fragment / behavior:

- Response renders as the glossy operation card, not paragraphs or kv-cards.
- Header text is `VM Operation`.
- Status badge shows `running`.
- Operation badge shows `start`.
- Detail rows show `VM` and `Node`.

### 10. Tip + Markdown-Lite Fallback

Source branch: heading handling, tip callout, inline code fallback.

Fixture input:

```text
## Next Step
Tip: Refresh the twin after Proxmox changes.
Use `pveproxy` logs if the task stalls.
```

Expected rendered fragment / behavior:

- `## Next Step` renders as the orange `h2` section header.
- `Tip:` renders as the highlighted tip callout with icon and bold `Tip:` label.
- Final sentence renders as a normal paragraph.
- `` `pveproxy` `` renders as an inline styled `<code>` chip.

## Priority Order

If snapshot budget is limited, lock these first:

1. Clarification prompt
2. Confirmation prompt envelope
3. Firewall rules pipe-KV list
4. VM inventory multiline shape
5. Key/value block with copyable SSH command

## Current Rendering Notes Worth Freezing

- A bare heading like `Firewall Rules` becomes a paragraph; `Firewall Rules:` becomes an orange section header.
- VM `trace` and `Source` fields are parsed for inventory rows but not shown in the rendered table.
- Confirmation UI lives outside `formatAgentResponse()` and must be snapshotted at the final message envelope layer.
