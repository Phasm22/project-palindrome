# Ingestion Status Dashboard

## Overview

Added comprehensive ingestion status visibility to the dashboard, allowing users to monitor ingestion runs, success/failure rates, per-source breakdowns, and recent history.

## What's Displayed

### Current Status
- **Scheduler Status**: Active/Inactive
- **Currently Running**: Whether ingestion is in progress
- **Last Run**: Relative time of last ingestion
- **Next Run**: Time until next scheduled ingestion

### Last Run Details
- **Overall Status**: Success/Failed with duration
- **Per-Source Breakdown**:
  - **Proxmox**: Success/failure, duration, error messages
  - **Network**: Success/failure, duration, entity/relationship counts, errors
  - **Firewall**: Success/failure, duration, entity/relationship counts, errors
  - **Temperature**: Nodes with/without temperature data
  - **Cleanup**: Stale entities deleted, duration

### Statistics
- **Total Runs**: Number of ingestion cycles
- **Success Rate**: Percentage of successful runs
- **Average Duration**: Mean ingestion duration
- **Total Cleaned**: Cumulative stale entities removed

### Recent History
- Last 5 ingestion runs with:
  - Timestamp
  - Success/failure status
  - Duration
  - Visual indicators (green/red borders)

## Implementation

### Backend Changes

1. **Enhanced IngestionScheduler** (`src/pce/scheduler/ingestion-scheduler.ts`)
   - Added `IngestionRunDetails` interface to track detailed run information
   - Tracks per-source success/failure, durations, errors, entity counts
   - Maintains run history (last 20 runs)
   - Exposes methods: `getLastRunDetails()`, `getRunHistory()`, `getIsRunning()`

2. **New API Endpoint** (`/api/dashboard/ingestion-status`)
   - Returns comprehensive ingestion status
   - Includes current state, last run details, history, and statistics
   - Calculates next run time

### Frontend Changes

1. **New Dashboard Section** (`dashboard/index.html`)
   - Added "Ingestion Status" section to Overview tab
   - Includes refresh button

2. **JavaScript Implementation** (`dashboard/js/overview.js`)
   - `loadIngestionStatus()` function fetches and displays status
   - Formats durations, relative times, and status badges
   - Shows per-source breakdown with error messages
   - Displays recent history timeline

3. **Auto-Refresh** (`dashboard/js/main.js`)
   - Ingestion status refreshes every 30 seconds when Overview tab is active
   - Manual refresh button available

## API Response Format

```json
{
  "active": true,
  "isRunning": false,
  "intervalMinutes": 5,
  "lastRun": "2026-01-28T03:54:36.759Z",
  "nextRun": "2026-01-28T03:59:36.759Z",
  "lastRunDetails": {
    "timestamp": "2026-01-28T03:54:36.759Z",
    "duration": 12281,
    "success": false,
    "proxmox": {
      "success": false,
      "duration": 138,
      "error": "Compilation error..."
    },
    "network": {
      "success": true,
      "duration": 1798,
      "entities": 11,
      "relationships": 0
    },
    "firewall": {
      "success": true,
      "duration": 10343,
      "entities": 104,
      "relationships": 5
    },
    "cleanup": {
      "duration": 735,
      "deleted": 4
    },
    "temperature": {
      "nodesWithTemp": 3,
      "nodesWithoutTemp": 0
    }
  },
  "runHistory": [...],
  "statistics": {
    "totalRuns": 10,
    "successCount": 8,
    "failureCount": 2,
    "successRate": 80.0,
    "avgDurationMs": 15000
  }
}
```

## Value Provided

1. **Visibility**: See exactly what's happening with ingestion
2. **Debugging**: Error messages help identify issues quickly
3. **Performance**: Duration tracking shows bottlenecks
4. **Health Monitoring**: Success rates indicate system health
5. **Temperature Tracking**: See which nodes have temperature data
6. **Cleanup Insights**: Understand what stale data is being removed

## Future Enhancements

- Add WebSocket support for real-time updates (no polling)
- Add ability to trigger manual ingestion from dashboard
- Add detailed logs viewer for each ingestion run
- Add charts/graphs for ingestion trends over time
- Add filtering by source type in history view
