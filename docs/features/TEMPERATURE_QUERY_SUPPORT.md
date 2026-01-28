# Temperature Query Support

## Overview

Temperature queries are now supported through the `proxmox_readonly` tool using a new `node_temperature` action. This allows users to query node temperatures in real-time via SSH sensors.

## Implementation

### New Action: `node_temperature`

Added to `proxmox_readonly` tool:
- **Action**: `node_temperature`
- **Required Parameter**: `node` (node name)
- **Data Source**: SSH sensors command (`sensors` or `sensors -j`)
- **Returns**: Structured temperature data including max, average, and individual sensor readings

### Usage Example

```typescript
{
  action: "node_temperature",
  node: "proxBig"
}
```

### Response Format

```json
{
  "node": "proxBig",
  "temperature": {
    "max": 45.5,
    "average": 42.3,
    "sensors": 4,
    "readings": [
      {
        "sensor": "coretemp-isa-0000/Core 0",
        "label": "Core 0",
        "value": 45.5,
        "unit": "celsius",
        "max": 80.0,
        "crit": 100.0
      }
    ]
  },
  "available": true
}
```

### Integration Points

1. **Tool Schema**: Added to `proxmox_readonly` action enum
2. **CLI Formatter**: Added temperature-specific formatting for readable output
3. **Temperature Fetcher**: Reuses existing `temperature-fetcher.ts` module
4. **Error Handling**: Gracefully handles SSH failures and missing sensors

### Query Flow

When a user asks "What's the temperature of the different nodes":

1. Agent recognizes temperature query intent
2. Uses `proxmox_readonly` with `action: "node_temperature"` for each node
3. Tool fetches temperature via SSH sensors
4. Returns structured temperature data
5. Agent formats response with temperature readings

### Benefits

- **Real-time Data**: Fetches current temperature, not just ingested data
- **Consistent Interface**: Uses same `proxmox_readonly` tool users are familiar with
- **Structured Output**: Returns normalized, structured JSON
- **Error Handling**: Gracefully handles unavailable sensors or SSH failures

### Related Features

- **Temperature Ingestion**: Temperature data is also ingested during Proxmox inventory ingestion (see `TEMPERATURE_INGESTION.md`)
- **SSH Tool**: Underlying SSH execution uses approved commands from `approved-commands.yaml`

### Future Enhancements

- Add temperature history tracking
- Alert on high temperatures
- Graph temperature trends
- Support for additional sensor types
