# Git Branch Restructure Plan

## Current Situation

**Branch:** `feature/parser-layer`  
**Status:** Most ahead branch, contains:
- ✅ Phase 4 (Parser Layer, Twin Layer, Reasoning Chains) - **COMPLETE**
- 🚀 Phase 5 (Action Layer) - **IN PROGRESS**

**Problem:** Branch name is misleading - it's no longer just "parser layer"

---

## Recommended Approach: Clean Phase Separation

### Option A: Merge Phase 4 → Main, New Branch for Phase 5 (RECOMMENDED)

**Rationale:**
- Phase 4 is complete and stable
- Clean separation between phases
- Main branch reflects completed work
- New branch for active development

**Steps:**

1. **Finalize Phase 4 work on current branch:**
   ```bash
   git checkout feature/parser-layer
   git add .
   git commit -m "Complete Phase 4: Parser, Twin, Reasoning Chains"
   ```

2. **Merge Phase 4 to main:**
   ```bash
   git checkout main
   git merge feature/parser-layer --no-ff -m "Merge Phase 4: Parser Layer, Twin Layer, Reasoning Chains complete"
   git push origin main
   ```

3. **Create new branch for Phase 5:**
   ```bash
   git checkout -b feature/action-layer
   git push -u origin feature/action-layer
   ```

4. **Tag Phase 4 completion:**
   ```bash
   git tag -a v0.4.0 -m "Phase 4 Complete: Parser, Twin, Reasoning Chains"
   git push origin v0.4.0
   ```

**Result:**
- `main` = Phase 4 complete (stable)
- `feature/action-layer` = Phase 5 in progress (active development)

---

### Option B: Rename Current Branch (QUICK FIX)

**Rationale:**
- Faster, less disruptive
- Keeps all work in one branch
- Good if you want to keep Phase 4 and 5 together

**Steps:**

1. **Rename branch locally:**
   ```bash
   git branch -m feature/parser-layer feature/action-layer
   ```

2. **Push new branch and delete old:**
   ```bash
   git push origin feature/action-layer
   git push origin --delete feature/parser-layer
   ```

3. **Update remote tracking:**
   ```bash
   git branch --set-upstream-to=origin/feature/action-layer feature/action-layer
   ```

**Result:**
- `feature/action-layer` = Phase 4 + Phase 5 (all work together)

---

### Option C: Keep Current, Document Transition (MINIMAL CHANGE)

**Rationale:**
- No git changes needed
- Just update documentation
- Good if you want to keep history intact

**Steps:**

1. **Update branch description:**
   ```bash
   git branch --edit-description feature/parser-layer
   # Add: "Phase 4 complete, Phase 5 (Action Layer) in progress"
   ```

2. **Update README/docs to reflect current state**

**Result:**
- Branch name stays the same but documented as multi-phase

---

## Recommendation: **Option A** (Merge to Main, New Branch)

**Why:**
1. **Clean history**: Main reflects completed, stable work
2. **Clear separation**: Each phase has its own branch
3. **Easy rollback**: Can always go back to Phase 4 stable state
4. **Professional**: Follows standard git workflow
5. **Tagging**: Can tag Phase 4 as a milestone

**Branch Structure After:**
```
main (Phase 4 complete)
  └── feature/action-layer (Phase 5 in progress)
      └── feature/dns-integration (future: DNS work)
      └── feature/network-ops (future: Network operations)
```

---

## Alternative: Keep Feature Branches Per Component

If you want more granular control:

```
main (Phase 4 complete)
  ├── feature/action-layer-core (VM create/destroy)
  ├── feature/action-layer-dns (DNS integration)
  ├── feature/action-layer-network (Network operations)
  └── feature/action-layer-firewall (Firewall operations)
```

**Merge strategy:** Merge component branches into `feature/action-layer` as they complete, then merge to main when Phase 5 is done.

---

## Current Branch Status

**Commits ahead of main:** 18+ commits  
**Contains:**
- Phase 4: Parser, Twin, Reasoning Chains ✅
- Phase 5: Action Layer foundation ✅
- Phase 5: VM create/destroy ✅
- Phase 5: Intent detection improvements ✅
- Phase 5: Ambiguity handling ✅

**Recommendation:** Option A - merge Phase 4 to main, create `feature/action-layer` for Phase 5 work.

---

## Next Steps After Restructure

1. **Update CI/CD** (if applicable) to use new branch names
2. **Update documentation** to reflect new branch structure
3. **Create branch protection rules** for main (require PR reviews)
4. **Set up branch naming convention** for future phases

---

## Branch Naming Convention (Future)

- `main` - Stable, completed phases
- `feature/phase-{N}-{name}` - Active phase development
- `feature/{component}` - Component-specific work
- `hotfix/{issue}` - Critical fixes
- `stable/production` - Production-ready releases

**Examples:**
- `feature/phase-5-action-layer`
- `feature/phase-5-dns-integration`
- `feature/phase-6-safety-layer`

