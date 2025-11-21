# Documentation Structure

## Overview

All project documentation has been reorganized into a machine-friendly hierarchical structure with clear categorization and machine-readable indexes.

## Directory Structure

```
docs/
├── INDEX.yaml              # Machine-readable index (YAML)
├── INDEX.json              # Machine-readable index (JSON)
├── README.md               # Main documentation index
├── MIGRATION.md            # Migration guide (this reorganization)
├── STRUCTURE.md            # This file
│
├── status/                 # Status & Progress (17 files)
│   ├── README.md
│   ├── DOD_VERIFICATION.md
│   ├── PCE_PHASE_*.md
│   ├── PHASE_IB_*.md
│   └── TL_*.md
│
├── guides/                 # Quick Start Guides (1 file)
│   ├── README.md
│   └── QUICK_START_TOPOLOGY.md
│
├── technical/              # Technical Documentation (5 files)
│   ├── README.md
│   ├── BUG_FIXES.md
│   ├── agent-notes.md
│   ├── filesystem-analysis-options.md
│   ├── management.md
│   └── security-openai-api.md
│
├── features/               # Feature Documentation (3 files)
│   ├── README.md
│   └── IP_RESOLUTION_*.md
│
├── tests/                  # Test Documentation (13 files)
│   ├── README.md
│   ├── proxmox-*.md
│   └── test-*.md
│
└── tools/                  # Tool Documentation (5 files)
    ├── README.md
    ├── tool-map.md
    ├── self-describing-tools.md
    ├── mcp-opnsense-integration.md
    ├── opnsense-ssh-setup.md
    └── ssh-tool-setup.md
```

## Statistics

- **Total Categories**: 6
- **Total Documentation Files**: 44 (excluding READMEs and indexes)
- **Total Files**: 51 (including READMEs)
- **Index Files**: 2 (YAML and JSON)
- **README Files**: 7 (one per category + main)

## Machine-Friendly Features

### 1. Structured Indexes

Both `INDEX.yaml` and `INDEX.json` provide:
- Complete file inventory
- Metadata for each document (title, type, category)
- Component/feature associations
- Phase/test level information
- Searchable structure

### 2. Category Organization

Each category has:
- Clear purpose and scope
- README explaining contents
- Consistent naming conventions
- Logical grouping

### 3. Naming Conventions

- **Status files**: `{PREFIX}_{IDENTIFIER}_STATUS.md`
- **Feature files**: `{FEATURE}_{TYPE}.md`
- **Test files**: `{component}-{type}.md` or `test-{type}.md`
- **Tool files**: `{tool}-{type}.md`

## Usage

### For Humans

1. Start with `docs/README.md` for navigation
2. Browse category folders based on your needs
3. Read category READMEs for context

### For Machines

1. Parse `INDEX.yaml` or `INDEX.json` for complete inventory
2. Use metadata to filter/search documents
3. Resolve paths programmatically using index

## Example: Finding Documentation

### Find all Phase I-B related docs:
```yaml
# In INDEX.yaml, search for:
phase: "I-B"
```

### Find all Proxmox test docs:
```yaml
# In INDEX.yaml, search for:
component: "proxmox"
category: "tests"
```

### Find all setup guides:
```yaml
# In INDEX.yaml, search for:
type: "setup"
```

## Benefits

1. **Discoverability**: Clear categories make finding docs easy
2. **Machine Processing**: Structured indexes enable automation
3. **Maintainability**: Organized structure simplifies updates
4. **Scalability**: Easy to add new docs in appropriate categories
5. **Consistency**: Standardized naming and structure
