# PCE & Ontology Code Review Notes

## Observations

1. **Ontology validation stops short of Proxmox entities.** The `validateNodeAttributes` switch enforces required fields for core types but falls through for `PVE_NODE`, `VM_INSTANCE`, and `PVE_STORAGE`, meaning malformed Proxmox nodes can enter the graph unchecked.
2. **Entity extraction prompt is out of sync with the ontology.** The LLM prompt only asks for a limited set of entity/relationship types and omits ontology additions (containers, dependencies, Proxmox types, HOSTS/HOSTS_ON/USES, etc.), making it hard for new tools to be discovered without retuning the prompt.
3. **EDL normalization hardcodes Host-centric assumptions.** Relationship normalization forces both ends to `Host`, and attribute construction only understands host/service shapes; other ontology node types rely on `any`, which defeats the typed schema and keeps aliasing from working for new tool outputs.
4. **Proxmox graph extraction uses ad-hoc IDs and bypasses ontology utilities.** Nodes are keyed with inline strings instead of the shared canonical ID/normalizer, so they may not dedupe with EDL-derived entities or future ingestion sources.

## Recommendations

- Extend `validateNodeAttributes` with explicit branches for all ontology node types (especially `PVE_NODE`, `VM_INSTANCE`, `PVE_STORAGE`) so ingestion from tool outputs is validated before hitting the graph store.
- Align the extractor prompt with `NodeType`/`RelationshipType` (or generate it from the schema) and allow tool metadata to register new entity types, keeping the LLM aware of new tools without manual prompt edits.
- In `EDLPipeline`, map attributes via an ontology-aware factory (e.g., type→attribute builder) and derive relationship endpoint types instead of defaulting to `Host`. That will let new tool outputs survive validation and alias mapping instead of being discarded.
- Reuse the shared normalizer (`generateCanonicalId`/`normalizeEntityText`) in the Proxmox extractor and store alias data, so graph IDs converge across ingestion paths and relationships can de-duplicate cleanly.
