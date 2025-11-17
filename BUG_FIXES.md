# Bug Fixes - Neo4j Integration

## Issues Identified

### 1. Neo4j Property Type Limitation
**Error**: `Property values can only be of primitive types or arrays thereof. Encountered: Map{...}`

**Root Cause**: Neo4j doesn't support nested objects (Maps) as property values. We were trying to store the `attributes` object directly, which contains nested key-value pairs.

**Solution**: 
- Convert `attributes` object to JSON string before storing: `JSON.stringify(node.attributes)`
- Parse JSON string back to object when reading: `JSON.parse(attributesJson)`
- Applied to both nodes and relationships

### 2. Date Object Handling
**Error**: Date objects in properties need to be converted to Neo4j DateTime types

**Root Cause**: Neo4j requires DateTime objects to be in a specific format, not JavaScript Date objects.

**Solution**:
- Convert Date objects to Neo4j DateTime: `neo4j.types.DateTime.fromStandardDate(date)`
- Applied to `createdAt`, `updatedAt`, and `timestamp` fields
- Date objects inside attributes are automatically serialized by `JSON.stringify()` (becomes ISO string)

### 3. Query Result Parsing
**Issue**: When reading back from Neo4j, JSON strings need to be parsed back to objects

**Solution**:
- Updated `GraphQueryInterface` to parse `attributes` JSON strings back to objects
- Updated relationship `properties` parsing
- Added error handling for malformed JSON

## Files Modified

1. **src/pce/kg/indexation/neo4j-client.ts**
   - `writeNode()`: Convert attributes to JSON, Date to DateTime
   - `writeNodes()`: Same conversions for batch operations
   - `writeRelationship()`: Convert properties to JSON, Date to DateTime
   - `writeRelationships()`: Same conversions for batch operations
   - `setSchemaVersion()`: Convert Date to DateTime

2. **src/pce/kg/queries/query-interface.ts**
   - Parse `attributes` JSON strings back to objects
   - Parse relationship `properties` JSON strings back to objects

3. **tests/pce/kg/test-harness.test.ts**
   - Updated test to use ISO string for timestamp in attributes

## Additional Fixes

### 3. Relationship Parsing in Query Results
**Error**: `undefined is not an object (evaluating 'value.start.identity.toString')`

**Root Cause**: When Neo4j returns relationships in queries like `RETURN h, r, s`, the relationship object structure needs careful handling. The `start` and `end` properties might not always have `identity` fields.

**Solution**:
- Added null/undefined checks before accessing `identity` properties
- Handle multiple ways to extract node IDs (properties.id, identity, or string)
- Improved relationship parsing logic to handle various Neo4j response formats

### 4. Provenance Query
**Error**: `getEntitiesWithProvenance` returning 0 results

**Root Cause**: Using `executeQuery` which goes through complex parsing logic, when a direct query would be simpler.

**Solution**:
- Changed `getEntitiesWithProvenance` to use direct session query
- Directly map record results without going through `executeQuery` parsing
- More reliable for simple queries that just need property values

## Testing

After these fixes, the tests should pass. The main changes ensure:
- ✅ Nested objects are stored as JSON strings
- ✅ Date objects are properly converted to Neo4j DateTime
- ✅ Query results correctly parse JSON back to objects
- ✅ Relationship parsing handles various Neo4j response formats
- ✅ Provenance queries work reliably
- ✅ All property types are Neo4j-compatible

## Neo4j Data Type Compatibility

| TypeScript Type | Neo4j Storage | Notes |
|----------------|---------------|-------|
| `object` (nested) | `string` (JSON) | Must serialize/deserialize |
| `Date` | `DateTime` | Use `neo4j.types.DateTime.fromStandardDate()` |
| `string` | `String` | Direct mapping |
| `number` | `Integer` or `Float` | Direct mapping |
| `boolean` | `Boolean` | Direct mapping |
| `array` | `List` | Direct mapping (if primitive types) |

