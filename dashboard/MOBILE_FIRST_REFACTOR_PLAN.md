# Mobile-First Refactoring Plan

## Current Stack
- **Framework**: Tailwind CSS (perfect for mobile-first - already built that way!)
- **JavaScript**: Vanilla ES modules
- **No changes needed to framework** - Tailwind is ideal for this refactor

## Key Issues Identified

### 1. **Fixed Spacing & Containers**
- `px-6 py-6` - Too much padding on mobile
- `max-w-7xl` - Container too wide, needs responsive max-width
- Fixed widths like `w-64` for sidebar don't adapt

### 2. **Tab Navigation**
- Horizontal scroll (`overflow-x-auto`) on mobile is poor UX
- 7 tabs don't fit on small screens
- Need dropdown/menu on mobile

### 3. **Chat Sidebar**
- Fixed `w-64` (256px) takes up too much space on mobile
- Should be collapsible/hidden on mobile
- Needs hamburger menu or bottom sheet pattern

### 4. **Floating Navigation**
- `fixed right-6 top-1/2` - Positioned off-screen on mobile
- Should be bottom-fixed or inline on mobile

### 5. **Status Grid**
- `minmax(200px, 1fr)` - Cards too wide for mobile
- Should be single column on very small screens

### 6. **Tables**
- Horizontal scroll works but poor UX
- Should convert to card layout on mobile

### 7. **Graph Container**
- Fixed `height: 800px` - Too tall for mobile screens
- Needs responsive height

### 8. **Touch Targets**
- Some buttons may be too small for mobile
- Need minimum 44x44px touch targets

## Mobile-First Approach

### Breakpoints (Tailwind Default)
- **Mobile**: Default (< 640px)
- **Tablet**: `sm:` (≥ 640px)
- **Desktop**: `md:` (≥ 768px)
- **Large**: `lg:` (≥ 1024px)
- **XL**: `xl:` (≥ 1280px)

### Refactoring Strategy

1. **Start with mobile styles** (no prefix)
2. **Add desktop enhancements** with `md:` or `lg:` prefixes
3. **Use Tailwind's responsive utilities** - they're mobile-first by default

## Implementation Plan

### Phase 1: Core Layout & Spacing
- [ ] Container: `px-3 py-4` → `md:px-6 md:py-6`
- [ ] Max-width: `max-w-full` → `md:max-w-7xl`
- [ ] Headings: Smaller on mobile, larger on desktop

### Phase 2: Navigation
- [ ] Tab bar: Convert to dropdown/select on mobile
- [ ] Alternative: Bottom navigation bar for mobile
- [ ] Keep horizontal tabs on `md:` and up

### Phase 3: Chat Interface
- [ ] Sidebar: Hidden by default on mobile
- [ ] Add hamburger menu button
- [ ] Sidebar as overlay/drawer on mobile
- [ ] Full sidebar on `md:` and up

### Phase 4: Components
- [ ] Floating nav: Bottom-fixed on mobile, right-side on desktop
- [ ] Status grid: Single column on mobile, multi-column on desktop
- [ ] Tables: Card layout on mobile, table on desktop
- [ ] Graph: `min-h-[400px]` → `md:h-[600px]` → `lg:h-[800px]`

### Phase 5: Touch & Interaction
- [ ] Ensure all buttons min 44x44px
- [ ] Increase tap target sizes on mobile
- [ ] Improve form input spacing

### Phase 6: Testing
- [ ] Test on 320px, 375px, 414px (common mobile widths)
- [ ] Test on 768px (tablet)
- [ ] Test on 1024px+ (desktop)
- [ ] Verify all interactions work

## Files to Modify

1. `dashboard/index.html` - Main layout and structure
2. `dashboard/css/input.css` - Tailwind source (may need custom utilities)
3. `dashboard/js/main.js` - Tab switching logic for mobile menu
4. `dashboard/js/chat.js` - Sidebar toggle functionality
5. `dashboard/js/overview.js` - Responsive table rendering
6. `dashboard/js/components.js` - Responsive component utilities

## Notes

- **No framework changes needed** - Tailwind CSS is perfect for this
- All changes use Tailwind's responsive utilities
- Maintains current dark theme and burnt orange accent
- Progressive enhancement approach (mobile → desktop)

## Build Instructions

After making these changes, rebuild the Tailwind CSS to include all responsive utilities:
```bash
bun run dashboard:build
# Or if that fails:
npx tailwindcss -i ./dashboard/css/input.css -o ./dashboard/css/styles.css --minify
```

The CSS file needs to be rebuilt to include all the `md:`, `sm:`, `lg:` responsive utilities used in the refactored HTML.

