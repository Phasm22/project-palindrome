# Documentation Migration Guide

This document describes the reorganization of project documentation into a machine-friendly structure.

## Changes Made

### New Structure

All markdown documentation has been organized into the following categories:

```
docs/
├── INDEX.yaml          # Machine-readable index (YAML format)
├── INDEX.json          # Machine-readable index (JSON format)
├── README.md           # Main documentation index
├── status/             # Status and progress tracking (17 files)
├── guides/             # Quick start guides (1 file)
├── technical/          # Technical documentation (5 files)
├── features/           # Feature-specific docs (3 files)
├── tests/              # Test documentation (13 files)
└── tools/              # Tool documentation (5 files)
```

### File Movements

#### Root → docs/status/
- `PCE_PHASE_IA_DOD_COMPLETE.md`
- `PCE_PHASE_IA_STATUS.md`
- `PCE_PHASE_IB_COMPLETE.md`
- `PCE_PHASE_IB_STATUS.md`
- `PCE_PHASE_IC_STATUS.md`
- `PCE_PHASE_II_STATUS.md`
- `PCE_PHASE_III_STATUS.md`
- `PHASE_IB_AUDIT.md`
- `PHASE_IB_COMPLETE.md`
- `PHASE_IB_IMPLEMENTATION.md`
- `TL_1A_STATUS.md`
- `TL_1B_STATUS.md`
- `TL_1C_STATUS.md`
- `TL_2A_6_PREREQUISITES.md`
- `TL_2A_STATUS.md`
- `DOD_VERIFICATION.md`

#### Root → docs/guides/
- `QUICK_START_TOPOLOGY.md`

#### Root → docs/technical/
- `BUG_FIXES.md`

#### docs/ → docs/features/
- `IP_RESOLUTION_IMPLEMENTED.md`
- `IP_RESOLUTION_SETUP.md`
- `IP_RESOLUTION_STRATEGY.md`

#### docs/ → docs/tests/
- `proxmox-*.md` (7 files)
- `test-*.md` (6 files)

#### docs/ → docs/tools/
- `tool-map.md`
- `self-describing-tools.md`
- `mcp-opnsense-integration.md`
- `opnsense-ssh-setup.md`
- `ssh-tool-setup.md`

#### docs/ → docs/technical/
- `agent-notes.md`
- `management.md`
- `filesystem-analysis-options.md`
- `security-openai-api.md`

## Machine-Friendly Features

### 1. Structured Index (INDEX.yaml)

The `INDEX.yaml` file provides machine-readable metadata for all documentation:
- File paths
- Titles and descriptions
- Categories and types
- Component/feature associations
- Phase/test level information

### 2. Category READMEs

Each category folder contains a README.md explaining:
- Purpose of the category
- Contents listing
- Naming conventions

### 3. Consistent Naming

Files follow consistent naming patterns:
- Status files: `{PREFIX}_{IDENTIFIER}_STATUS.md`
- Feature files: `{FEATURE}_{TYPE}.md`
- Test files: `{component}-{type}.md` or `test-{type}.md`

## Benefits

1. **Discoverability**: Clear categorization makes it easy to find relevant documentation
2. **Machine Processing**: INDEX.yaml enables automated documentation processing
3. **Maintainability**: Organized structure makes it easier to maintain and update docs
4. **Scalability**: New documentation can be easily categorized and added

## Updating References

If you have code or scripts that reference old documentation paths, update them to use the new structure. The INDEX.yaml file can be used to programmatically resolve old paths to new ones.

## Adding New Documentation

When adding new documentation:
1. Place files in the appropriate category folder
2. Update `docs/INDEX.yaml` with the new file's metadata
3. Follow existing naming conventions
4. Update the category's README.md if needed
