Perfect — that means you’re ready for **Phase 4: Network + Interfaces** with zero blockers.

Here’s the **full Phase 4 spec** in one pass, designed exactly to the standard that Phase 3 just established.
This is the canonical document your implementation will follow.

---

# **Phase 4 Specification: Network + Interfaces Domain**

**(Twin-backed ingestion, canonical entities, Cypher queries, reasoning chains)**

---

# 1. **Directory Structure**

```
src/
  parsers/
    network/
      proxmox-interface-parser.ts
      opnsense-interface-parser.ts
      network-utils.ts
    types.ts
    registry.ts

  twin/
    models/
      entities.ts        # add NetworkInterface, NetworkSubnet
      relationships.ts   # add ROUTES_TO, CONNECTS_TO
    api/
      twin-query-service.ts   # extend with network ops
    state/
      twin-updater.ts         # unchanged except for new entity types

  reasoning/
    chains/
      network.ts       # interface/subnet/exposure chains
    router/
      detectNetworkIntent.ts

src/tools/
  TwinQueryTool.ts      # already exists, will add network actions
```

---

# 2. **Canonical Entities (Zod)**

Add these to `src/twin/models/entities.ts`.

### **2.1 NetworkInterface**

```ts
export const NetworkInterfaceSchema = z.object({
  id: z.string(),                    // network-if:yin:vtnet0
  type: z.literal("network_interface"),
  nodeName: z.string(),              // proxBig, yin, yang
  vmId: z.string().nullable(),       // compute-vm:* if attached
  name: z.string(),                  // vtnet0, eth0, ens3, tap...
  mac: z.string().nullable(),
  ips: z.array(z.string()),          // ["172.16.0.10/22"]
  primaryIp: z.string().nullable(),
  cidrs: z.array(z.string()),
  status: z.enum(["up", "down", "unknown"]),
  vlan: z.string().nullable(),        // "50" or null
  parent: z.string().nullable(),      // bond0, lagg0, etc.
  collectedAt: z.string()
});
```

### **2.2 NetworkSubnet**

```ts
export const NetworkSubnetSchema = z.object({
  id: z.string(),                // subnet:172.16.0.0/22
  type: z.literal("network_subnet"),
  cidr: z.string(),
  mask: z.number(),
  gateway: z.string().nullable(),
  ifaceCount: z.number(),
  collectedAt: z.string()
});
```

---

# 3. **Canonical Relationships**

Add to `src/twin/models/relationships.ts`:

### **3.1 CONNECTS_TO**

```
(network_interface) -[:CONNECTS_TO]-> (network_subnet)
```

### **3.2 ROUTES_TO**

```
(compute_vm | compute_node) -[:ROUTES_TO]-> (compute_node | compute_vm)
```

Generated from subnet membership + firewall allow rules (Phase 4.5).

---

# 4. **Parser Specs**

## 4.1 Proxmox Interface Parser

File: `proxmox-interface-parser.ts`

Input:

* `proxmox_readonly` → `nodes/{node}/network`
* `proxmox_readonly` → `nodes/{node}/qemu/{vmid}/config`

Output:

* NetworkInterface entities
* NetworkSubnet entities
* CONNECTS_TO edges
* (VM → interface attachment)

Normalization rules:

* Normalize interfaces: `vtnet0`, `tap100i0`, `ens18`, etc.
* Extract subnets from CIDR
* Build subnet entity for each unique CIDR
* Derive primaryIp = lowest-address IPv4
* vmId = null unless interface belongs to VM

Handling VLANs:

* Read `tag` field from Proxmox
* Derive numeric string or null
* Normalize parent interface (bondX, bridgeX)

---

## 4.2 OPNsense Interface + Subnet Parser

File: `opnsense-interface-parser.ts`

Input:

* MCP server: `interfaces_manage` methods:

  * `listInterfaces`
  * `getInterface`
  * `listVlan`
  * `listVip` (optional)

Output:

* Interfaces with IPs, VLANs
* Subnets with gateway
* CONNECTS_TO edges

Normalization:

* IPs come in “addr/mask” form
* Gateway from MCP → insert into subnet entity
* status derived from “up” boolean

---

# 5. **TwinQueryService (Network Extensions)**

Add these Cypher operations:

### **5.1 list_interfaces**

```
MATCH (i:TwinEntity {type:'network_interface'})
RETURN i ORDER BY i.nodeName, i.name
```

### **5.2 interfaces_by_node**

```
MATCH (i:TwinEntity {type:'network_interface'})
WHERE i.nodeName = $node
RETURN i ORDER BY i.name
```

### **5.3 vms_by_subnet**

```
MATCH (i:TwinEntity {type:'network_interface'})-[:CONNECTS_TO]->(s:TwinEntity {type:'network_subnet'})
MATCH (vm:TwinEntity {type:'compute_vm'}) WHERE vm.id = i.vmId
RETURN vm, s
```

### **5.4 reachability**

```
MATCH (src:TwinEntity {id:$from})-[:CONNECTS_TO]->(s:TwinEntity {type:'network_subnet'})
MATCH (dst:TwinEntity)-[:CONNECTS_TO]->(s)
RETURN dst
```

### **5.5 exposure_map (Phase 4.5)**

Subnet + firewall rule intersection.

---

# 6. **TwinQueryTool Additions**

Extend the tool schema with new actions:

```ts
network_list_interfaces
network_interfaces_by_node
network_vms_by_subnet
network_reachability
```

TwinQueryTool must route each to the corresponding TwinQueryService method.

---

# 7. **Reasoning Layer (Network Chains)**

Add file: `src/reasoning/chains/network.ts`

Chains:

* `describe_network`
* `list_node_interfaces`
* `vm_connectivity`
* `reachability`
* `vm_exposure_analysis` (Phase 4.5)

Router: `detectNetworkIntent.ts`
Triggers on:

* “interfaces”
* “network”
* “subnet”
* “reachable”
* “ping”
* “vlan”
* “exposed”
* “open”
* “port” (Phase 4.5)

---

# 8. **Ingestion Pipelines**

Add new ingestion job:

`src/pce/ingestion/network-ingestion.ts`

Steps:

1. Pull Proxmox network data
2. Pull OPNsense network/interface data (MCP)
3. Combine + dedupe
4. Run parsers for interfaces + subnets
5. Upsert into twin
6. Log structured summary to ingestion metrics

Integrate into full ingestion bundle:
`ingest-all.ts` should run compute + network.

---

# 9. **Validation Plan (Phase 4 Exit Criteria)**

### After ingestion, Neo4j must show:

```
COUNT(network_interface) ≥ physical+vm interfaces
COUNT(network_subnet) ≥ unique CIDRs
```

### Network queries must answer correctly via twin_query:

1. “List all interfaces on proxBig”
2. “Which VMs share subnets with yin?”
3. “Can vm-101 reach vm-100?”
4. “Show the VLANs and subnets configured.”
5. “Which subnets have gateways?”
6. “Which nodes have interfaces that are down?”

### None of these queries may call:

* proxmox_readonly
* ssh_execute
* opnsense_readonly
  unless explicitly prompted.

---

# 10. **After Phase 4 → Phase 4.5 (Exposure Graph)**

Once networks + subnets work:

You can build:

```
VM → interface → subnet → firewall rules → exposure surface
```

This is the precursor to:

* attack paths
* blast-radius
* reachability trees
* service inventory
* anomaly detection