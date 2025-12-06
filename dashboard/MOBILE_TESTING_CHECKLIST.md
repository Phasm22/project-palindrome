# Mobile Testing Checklist

This document provides a comprehensive testing checklist for the Palindrome Dashboard on various mobile devices and viewport sizes.

## Testing Viewports

### Mobile Devices (Portrait)
- [ ] **320px** - Smallest common mobile width (iPhone SE, older Android)
- [ ] **375px** - iPhone 12/13/14 standard
- [ ] **414px** - iPhone 12/13/14 Pro Max, larger Android devices

### Tablet Devices
- [ ] **768px** - iPad portrait, tablet breakpoint
- [ ] **1024px** - iPad landscape

### Desktop
- [ ] **1280px+** - Standard desktop width

## Feature Testing

### 1. Navigation & Tabs
- [ ] Mobile dropdown menu appears and functions correctly
- [ ] All 7 tabs are accessible via dropdown
- [ ] Desktop horizontal tabs display correctly
- [ ] Tab switching works smoothly on both mobile and desktop
- [ ] Active tab is clearly indicated
- [ ] Tab animations don't cause performance issues

### 2. Chat Interface
- [ ] Sidebar toggle button is visible and accessible on mobile
- [ ] Sidebar opens as overlay on mobile
- [ ] Sidebar backdrop appears and closes sidebar on click
- [ ] Escape key closes sidebar
- [ ] Focus trap works in sidebar (Tab key cycles through elements)
- [ ] Focus returns to toggle button when sidebar closes
- [ ] Sidebar displays full-width on desktop
- [ ] Chat input is accessible and doesn't overlap keyboard
- [ ] Chat input respects safe-area insets on iOS
- [ ] Send button is properly sized (min 44x44px touch target)
- [ ] Enter key behavior: new line on mobile, send on desktop

### 3. Overview Tab
- [ ] Execution stats display correctly
- [ ] Cluster status cards are readable
- [ ] System health indicators are visible
- [ ] Floating navigation buttons work on mobile (bottom-fixed)
- [ ] Floating navigation buttons work on desktop (right-side)
- [ ] Navigation buttons have proper glow effects
- [ ] Tables display as cards on mobile
- [ ] Tables display as tables on desktop
- [ ] Horizontal scroll works for tables when needed

### 4. Tool Executions Tab
- [ ] Table/card layout switches correctly at breakpoint
- [ ] Filter controls are accessible
- [ ] Refresh button works
- [ ] Data loads and displays correctly
- [ ] Error states are visible

### 5. Reasoning Traces Tab
- [ ] Traces display correctly
- [ ] Refresh button works
- [ ] Data loads and displays correctly

### 6. Ontology Graph Tab
- [ ] Graph container has proper height on mobile (min 400px)
- [ ] Graph container scales correctly on tablet (600px)
- [ ] Graph container scales correctly on desktop (800px)
- [ ] Graph is interactive (zoom, pan, click)
- [ ] Zoom controls are accessible and touch-friendly
- [ ] Search box is visible and functional
- [ ] Node tooltips appear correctly with ARIA attributes
- [ ] Tooltips don't go off-screen
- [ ] Graph legend/sidebar stacks below graph on mobile
- [ ] Graph legend/sidebar displays beside graph on desktop
- [ ] High-DPI displays render graph clearly (no blur)
- [ ] Graph resizes correctly on orientation change

### 7. RAG Diagnostics Tab
- [ ] Query input is accessible
- [ ] Test button works
- [ ] Results display correctly
- [ ] Long results scroll properly

### 8. Query Tab
- [ ] Query type selector works
- [ ] RAG query interface displays correctly
- [ ] Graph query interface displays correctly
- [ ] Cypher query interface displays correctly
- [ ] Results display correctly
- [ ] Long results scroll properly

## Accessibility Testing

### Keyboard Navigation
- [ ] All interactive elements are keyboard accessible
- [ ] Tab order is logical
- [ ] Focus indicators are visible
- [ ] Escape key closes modals/sidebars
- [ ] Enter/Space activate buttons

### Screen Reader
- [ ] ARIA labels are present where needed
- [ ] Role attributes are correct (dialog, tooltip, etc.)
- [ ] aria-hidden is used appropriately
- [ ] aria-modal is set for overlays
- [ ] Content is announced correctly

### Touch Targets
- [ ] All buttons are at least 44x44px
- [ ] Interactive elements have adequate spacing
- [ ] No overlapping touch targets

## Performance Testing

### Mobile Performance
- [ ] Page loads within 3 seconds on 3G
- [ ] Animations are smooth (60fps)
- [ ] No janky scrolling
- [ ] Graph renders without lag
- [ ] Tab switching is responsive

### Battery & Resource Usage
- [ ] No excessive CPU usage
- [ ] Animations respect prefers-reduced-motion
- [ ] Background processes don't drain battery

## Visual Testing

### Layout
- [ ] No horizontal scrolling on any viewport
- [ ] Content doesn't overflow containers
- [ ] Safe-area insets respected on iOS
- [ ] Fixed elements don't overlap content
- [ ] Sticky elements work correctly

### Typography
- [ ] Text is readable at all sizes
- [ ] Font sizes scale appropriately
- [ ] Line heights are comfortable
- [ ] No text truncation issues

### Colors & Contrast
- [ ] Text meets WCAG AA contrast ratios
- [ ] Interactive elements have clear states
- [ ] Focus indicators are visible
- [ ] Dark theme is consistent

## Browser Testing

Test on the following browsers/devices:

### iOS
- [ ] Safari (latest)
- [ ] Chrome (latest)

### Android
- [ ] Chrome (latest)
- [ ] Firefox (latest)
- [ ] Samsung Internet

### Desktop
- [ ] Chrome (latest)
- [ ] Firefox (latest)
- [ ] Safari (latest)
- [ ] Edge (latest)

## Known Issues & Notes

Document any issues found during testing:

- Issue: [Description]
- Viewport: [Size]
- Browser: [Browser/Version]
- Steps to reproduce: [Steps]
- Expected: [Expected behavior]
- Actual: [Actual behavior]

## Testing Tools

### Browser DevTools
- Chrome DevTools Device Mode
- Firefox Responsive Design Mode
- Safari Responsive Design Mode

### Physical Devices (Recommended)
- iPhone (various models)
- Android phone (various models)
- iPad/Tablet

### Online Testing Tools
- BrowserStack
- LambdaTest
- Responsive Design Checker

## Automated Testing

Consider adding automated tests for:
- Viewport breakpoint behavior
- Touch target sizes
- Keyboard navigation
- ARIA attribute presence
- Performance metrics

## Sign-off

- [ ] All critical issues resolved
- [ ] All viewports tested
- [ ] All browsers tested
- [ ] Accessibility verified
- [ ] Performance acceptable
- [ ] Ready for production

**Last Updated:** [Date]
**Tested By:** [Name]

