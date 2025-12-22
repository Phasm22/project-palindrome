# GitHub Actions Workflows

## CI Workflow (`ci.yml`)

Low-friction CI that runs on every push and PR:

### Jobs

1. **Tests** (~5-10 min)
   - Runs all tests with Qdrant and Neo4j services available
   - Tests gracefully skip if env vars are missing
   - Single job = simpler, faster feedback

2. **Type Check** (fast, ~1 min)
   - TypeScript type checking
   - Catches type errors before merge

### Test Strategy

**Current approach:**
- All tests run together (Bun handles it)
- Tests check for env vars and skip if missing
- No test categorization needed initially
- Single test job = lower friction

**Future improvements (if needed):**
- Add test tags (`@unit`, `@integration`) to categorize
- Split test runs by category
- Add coverage reporting (optional)

### Secrets

Set these in GitHub repo settings → Secrets:
- `OPENAI_API_KEY` (optional - tests skip if not set)

### Coverage

No coverage reporting by default (low friction). To add:
1. Install `@vitest/coverage-v8` (already in package.json)
2. Add coverage step to workflow
3. Upload coverage reports

