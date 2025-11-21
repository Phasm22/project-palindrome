# Documentation

This directory contains all project documentation organized into machine-friendly categories.

## Structure

```
docs/
├── INDEX.yaml          # Machine-readable index of all documentation
├── status/             # Project status and progress tracking
├── guides/             # Quick start guides and how-tos
├── technical/          # Technical implementation details
├── features/           # Feature-specific documentation
├── tests/              # Test documentation and debugging
└── tools/              # Tool-specific documentation
```

## Quick Navigation

### Status & Progress
- [Definition of Done Verification](status/DOD_VERIFICATION.md)
- [Phase Status Reports](status/) - All PCE phase and test level status files

### Getting Started
- [Quick Start: Topology Ingestion](guides/QUICK_START_TOPOLOGY.md)

### Technical Documentation
- [Architecture: Tool Separation](technical/architecture-tool-separation.md)
- [Architecture: Implementation Complete](technical/architecture-implementation-complete.md)
- [Bug Fixes](technical/BUG_FIXES.md)
- [Management Guide](technical/management.md)
- [Agent Environment Notes](technical/agent-notes.md)
- [Documentation Structure](technical/structure.md)
- [Documentation Migration](technical/migration.md)

### Features
- [IP Resolution](features/) - Strategy, setup, implementation, and recommendations

### Testing
- [Proxmox Tests](tests/proxmox-test-status.md)
- [Test Execution Plan](tests/test-execution-plan.md)

### Tools
- [Tool Map](tools/tool-map.md)
- [OPNsense Integration](tools/mcp-opnsense-integration.md)
- [SSH Setup](tools/ssh-tool-setup.md)
- [Proxmox Tool Capabilities](tools/proxmox-capabilities.md)

## Machine-Readable Index

For automated processing, see [INDEX.yaml](INDEX.yaml) which provides structured metadata about all documentation files including:
- File paths
- Titles and descriptions
- Categories and types
- Component/feature associations
- Phase/test level information

## Contributing

When adding new documentation:
1. Place files in the appropriate category folder
2. Update `INDEX.yaml` with the new file's metadata
3. Follow existing naming conventions (kebab-case for files)
