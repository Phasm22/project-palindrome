# Temperature Query via Digital Twin

## Overview

Temperature queries now use the digital twin instead of real-time SSH calls. Temperature data is ingested during Proxmox inventory ingestion and stored in the twin, making queries faster and more consistent with the architecture.

## Changes Made

### 1. Temperature Storage in Twin

- **Updated `ComputeNodeEntitySchema`**: Added optional `temperature` field to node entity data
- **Ingestion**: Temperature is fetched via SSH during twin ingestion and stored in `entity.data.temperature`
- **Structure**: Temperature data includes max, average, sensors count, and individual readings

### 2. Twin Query Support

- **New Operation**: `node_temperature` in `TwinQueryTool`
- **Service Method**: `getNodeTemperature()` in `TwinQueryService`
- **Query Options**: Can query all nodes or a specific node by name
- **Returns**: Temperature data from twin (max, average, sensors, readings)

### 3. Updated Agent Guidance

- **System Prompt**: Updated to prefer `twin_query` for temperature queries
- **Tool Selection**: Temperature queries should use `twin_query` with `operation: "node_temperature"`, not `proxmox_readonly`

### 4. Cleanup Support

- **Automatic**: Temperature data is automatically cleaned up when stale nodes are removed
- **No Special Handling Needed**: Since temperature is stored in `dataJson`, it's removed when the entity is deleted
- **Stale Node Cleaner**: Already handles cleanup of all node data including temperature

## Usage

### Query All Node Temperatures

```typescript
{
  operation: "node_temperature"
}
```

### Query Specific Node Temperature

```typescript
{
  operation: "node_temperature",
  params: { nodeName: "proxBig" }
}
```

### Response Format

```json
{
  "kind": "node_temperature",
  "data": [
    {
      "id": "compute-node:proxbig",
      "name": "proxBig",
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
      }
    }
  ]
}
```

## Benefits

1. **Performance**: No SSH calls during queries - data is already in the twin
2. **Consistency**: Follows architecture principle of preferring twin over live APIs
3. **Efficiency**: Temperature fetched once during ingestion, queried many times
4. **Cleanup**: Automatically handled by existing stale node cleanup

## Migration Notes

- **Real-time Action**: The `node_temperature` action in `proxmox_readonly` still exists but should not be used for normal queries
- **Fallback**: Can be used as fallback if twin data is unavailable, but twin should be preferred
- **Ingestion**: Temperature is fetched during ingestion, so data freshness depends on ingestion schedule (default: every 5 minutes)

## Related Features

- **Temperature Ingestion**: See `TEMPERATURE_INGESTION.md` for ingestion details
- **Stale Node Cleanup**: See `STALE_NODE_CLEANUP.md` for cleanup details
- **Twin Query Tool**: See `TwinQueryTool.ts` for query interface
