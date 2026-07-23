# Test Strategy & CI Recommendations

## Current State

- **Approximately 137 test files** (137 on 2026-07-23; auto-count with `find tests -name "*.test.ts" | wc -l`)
- **Bun test runner** (fast, native)
- **Graceful skipping** - tests check for env vars and skip if missing
- **Mixed syntax** - some use `test()`, some use `describe/it` (both work with Bun)

## GitHub Actions Setup

Created `.github/workflows/ci.yml` with:

1. **Unit Tests** (fast, ~2-5 min)
   - No services needed
   - Runs first for quick feedback

2. **Integration Tests** (slower, ~5-10 min)
   - Qdrant + Neo4j services
   - Tests that need services will run

3. **Type Check** (fast, ~1 min)
   - Catches TypeScript errors

## Recommendations

### Option 1: Keep It Simple (Recommended for Low Friction)

**Current approach is fine:**
- All tests run together
- Tests skip gracefully when services/env vars missing
- No refactoring needed

**Pros:**
- ✅ Zero friction
- ✅ Works immediately
- ✅ Tests already handle missing dependencies

**Cons:**
- ⚠️ Can't easily run "fast tests only" locally
- ⚠️ Harder to see which tests are unit vs integration

### Option 2: Add Test Tags (Low-Medium Friction)

Add simple tags to categorize tests:

```typescript
// Unit test
test("classifyIntent handles queries", () => {
  // ...
});

// Integration test (requires services)
test("RAG retrieval works with Qdrant", async () => {
  if (!process.env.QDRANT_URL) return; // skip
  // ...
}, { tags: ["integration"] });
```

Then run:
```bash
bun test --tags unit        # fast tests only
bun test --tags integration # slow tests only
bun test                    # all tests
```

**Pros:**
- ✅ Can run fast tests locally
- ✅ Can split CI jobs by tag
- ✅ Minimal refactoring

**Cons:**
- ⚠️ Need to tag the full test set (~137 files as of 2026-07-23)
- ⚠️ Bun's tag support might need checking

### Option 3: Organize by Directory (Medium Friction)

Move tests into `tests/unit/` and `tests/integration/`:

```
tests/
  unit/
    reasoning/
    parsers/
    tools/ (mocked)
  integration/
    flows/
    pce/
    tools/ (real services)
```

**Pros:**
- ✅ Clear organization
- ✅ Easy to run subsets
- ✅ Self-documenting

**Cons:**
- ⚠️ Requires moving 50 files
- ⚠️ More refactoring

## Coverage Strategy

### Current: No Coverage (Low Friction)

**Pros:**
- ✅ Fast CI
- ✅ No maintenance
- ✅ Focus on functionality over metrics

**Cons:**
- ⚠️ Don't know what's tested
- ⚠️ Hard to find gaps

### Option: Basic Coverage (Medium Friction)

Add coverage reporting:

```yaml
- name: Generate coverage
  run: bun test --coverage
  
- name: Upload coverage
  uses: codecov/codecov-action@v3
```

**Recommendation:** Start without coverage, add later if needed.

## My Recommendation

**Start with Option 1 (Keep It Simple):**

1. ✅ Use the CI workflow I created
2. ✅ Keep current test structure
3. ✅ Tests already skip gracefully
4. ✅ Add tags later if you want faster feedback

**When to refactor:**
- If CI becomes too slow (>15 min)
- If you want to run "fast tests only" locally
- If you need coverage metrics

## Quick Wins

1. **Add test timeout** to prevent hanging:
   ```typescript
   test("slow test", async () => {
     // ...
   }, { timeout: 30000 });
   ```

2. **Add test grouping** (optional):
   ```typescript
   describe("Intent Classifier", () => {
     test("handles queries", () => {});
     test("handles actions", () => {});
   });
   ```

3. **Add CI badges** to README (optional):
   ```markdown
   ![CI](https://github.com/user/repo/workflows/CI/badge.svg)
   ```

## Next Steps

1. ✅ CI workflow created
2. ⏭️ Test it on a PR
3. ⏭️ Adjust timeouts if needed
4. ⏭️ Add tags later if you want faster feedback
