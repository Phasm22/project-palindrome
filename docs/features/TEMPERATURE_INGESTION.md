# Temperature Data Ingestion

## Overview

Temperature data from Proxmox nodes is now automatically ingested during the Proxmox inventory ingestion process. Temperature readings are fetched via SSH using the `sensors` command and included in node profile documents.

## Implementation Details

### Temperature Data Source

- **Source**: Hardware sensors via SSH (`sensors` command)
- **Availability**: Only available via SSH, not through Proxmox API
- **Nodes Supported**: proxBig (172.16.0.10), yin (172.16.0.11), YANG (172.16.0.12)

### Data Flow

1. **Fetching**: During node profile document generation, temperature data is fetched via SSH
2. **Parsing**: Supports both JSON (`sensors -j`) and text (`sensors`) output formats
3. **Documentation**: Temperature data is included in the node profile document with:
   - Maximum temperature
   - Average temperature
   - Number of sensors
   - Individual sensor readings (if ≤5 sensors)
4. **Storage**: Temperature data is stored in:
   - Vector store (as part of node profile documents)
   - Knowledge graph (as node attributes)
   - Digital twin (in node entity data)

### Files Modified

1. **`src/tools/proxmox/readonly/temperature-fetcher.ts`** (NEW)
   - Fetches temperature data via SSH
   - Parses sensors JSON and text output
   - Maps Proxmox node names to SSH hosts

2. **`src/tools/proxmox/readonly/vector-document-generator.ts`**
   - Updated `generateNodeProfileDocument()` to fetch and include temperature data
   - Adds temperature section to node profile documents

3. **`src/pce/ingestion/proxmox-ingestion.ts`**
   - Updated `parseNodeProfile()` to extract temperature data from documents
   - Includes temperature in graph node attributes

### Temperature Data Structure

```typescript
interface TemperatureReading {
  sensor: string;        // Sensor identifier (e.g., "coretemp-isa-0000/Core 0")
  value: number;         // Temperature in Celsius
  unit: "celsius";
  label?: string;        // Human-readable label
  max?: number;         // Maximum threshold
  crit?: number;        // Critical threshold
}

interface NodeTemperatureData {
  node: string;
  temperatures: TemperatureReading[];
  timestamp: string;
  source: "ssh_sensors";
}
```

### Usage

Temperature data is automatically included when running:

```bash
bun run scripts/ingest-proxmox.ts
```

The temperature data will appear in:
- Node profile documents (`.pce/raw-documents/*.txt`)
- Knowledge graph node attributes
- Vector store embeddings (searchable via RAG queries)

### Querying Temperature Data

Temperature data can be queried through:
1. **RAG queries**: "What's the temperature of proxBig?"
2. **Knowledge graph**: Query `PVE_NODE` entities with `temperature` attributes
3. **Digital twin**: Access via `COMPUTE_NODE` entities

### Error Handling

- Temperature fetching failures are non-fatal - node profile generation continues even if temperature data is unavailable
- Falls back from JSON to text format if JSON parsing fails
- Logs warnings but doesn't fail ingestion if SSH access is unavailable

### Future Enhancements

Potential improvements:
- Add temperature history tracking (temporal data)
- Alert on high temperatures
- Graph temperature trends over time
- Support for additional sensor types (disk, network, etc.)
