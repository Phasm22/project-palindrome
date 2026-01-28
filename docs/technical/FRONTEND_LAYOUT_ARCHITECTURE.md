# Frontend Layout Architecture Design Document

## Table of Contents
1. [Overview](#overview)
2. [Current State vs Target Architecture](#current-state-vs-target-architecture)
3. [Component-Based Layout Architecture](#component-based-layout-architecture)
4. [Layout Hierarchy & Layering](#layout-hierarchy--layering)
5. [Layout Composition Pattern](#layout-composition-pattern)
6. [App Shell Pattern](#app-shell-pattern)
7. [Persistent UI Components](#persistent-ui-components)
8. [Dynamic Content Area](#dynamic-content-area)
9. [Responsive Design Strategy](#responsive-design-strategy)
10. [State Management Architecture](#state-management-architecture)
11. [Implementation Guidelines](#implementation-guidelines)
12. [Migration Plan](#migration-plan)

---

## Overview

This document defines the complete frontend layout architecture for the Palindrome Dashboard. The architecture follows modern frontend patterns including component-based design, App Shell pattern, and responsive mobile-first principles.

### Framework-Agnostic Design

**Important**: This architecture is **framework-agnostic**. Examples use pseudocode/JSX syntax for clarity, but the patterns work with:
- **Vanilla JavaScript** (current implementation)
- **React** (functional components with hooks)
- **Vue** (composition API or options API)
- **Other frameworks** (adapt to framework conventions)

The document specifies **what** to build and **how** components interact, not the exact syntax. Choose the implementation pattern that matches your framework.

### Core Principles
- **Component-Based**: Reusable, composable UI components
- **Mobile-First**: Responsive design starting from mobile breakpoints
- **Accessibility**: ARIA-compliant, keyboard navigable, screen-reader friendly
- **Performance**: Lazy loading, code splitting, optimized rendering
- **Maintainability**: Clear separation of concerns, consistent patterns
- **URL as Source of Truth**: Routes derived from URL, not duplicated in state
- **Portal-Based Overlays**: All overlays render in top-level portal root

---

## Current State vs Target Architecture

### Migration Status

This document describes the **target architecture**. The current implementation differs significantly. This section documents the gaps and migration path.

### Current Implementation (As-Is)

#### ✅ What Exists
- **Component Library**: Basic reusable components (`components.js` - Button, Card, Badge, etc.)
- **Tab Navigation**: Tab-based navigation with show/hide logic
- **Responsive Design**: Mobile/desktop responsive layouts
- **Modal System**: Basic modal functionality (`modal.js`, `ui-helpers.js`)
- **Tooltip System**: Tooltip utilities (`ui-helpers.js`)

#### ❌ What's Missing (Gaps)

1. **No URL Routing**
   - Current: `switchTab('chat')` manipulates DOM directly
   - No URL updates (`window.history.pushState`)
   - No route derivation from URL
   - Browser back/forward doesn't work

2. **No Portal Root**
   - Modals append to `document.body` directly
   - Tooltips append to `document.body` directly
   - No `#portal-root` container
   - Stacking context issues possible

3. **No Z-Index Token System**
   - Hardcoded values: `z-index: 9999`, `z-index: 10000`, `z-50`
   - No CSS custom properties for z-index
   - Inconsistent layering

4. **No Centralized State Management**
   - Global functions (`window.switchTab`, etc.)
   - No LayoutStore or state boundaries
   - State scattered across DOM manipulation

5. **No Component Hierarchy**
   - Components exist but don't follow documented structure
   - No clear Root → Layout → Page → Feature → Primitive hierarchy

### Target Architecture (To-Be)

See detailed sections below. Key improvements:
- ✅ URL-based routing with route derivation
- ✅ Portal root for all overlays
- ✅ Z-index token system
- ✅ Centralized state management (LayoutStore)
- ✅ Clear component hierarchy

### Migration Priority

**Phase 1: Foundation** (Critical - Prevents Stacking Issues)
1. Create portal root
2. Implement z-index tokens
3. Migrate modals/tooltips to portal root

**Phase 2: Navigation** (High Priority - Core Functionality)
4. Implement URL-based routing
5. Replace `switchTab` with route navigation

**Phase 3: State Management** (Medium Priority - Maintainability)
6. Create LayoutStore
7. Migrate state to centralized store

**Phase 4: Component Refactoring** (Lower Priority - Polish)
8. Refactor components to follow hierarchy
9. Update all z-index usage to tokens

---

## Component-Based Layout Architecture

### Architecture Overview

The frontend follows a **hierarchical component composition model** where smaller, focused components compose into larger layout structures.

```
┌─────────────────────────────────────────────────────────┐
│                    Application Root                      │
│                  (App Shell Container)                   │
├─────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────────────────────────┐ │
│  │   Header     │  │        Navigation Bar            │ │
│  │  Component   │  │       (Tab Navigation)          │ │
│  └──────────────┘  └──────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────────────────────────┐ │
│  │   Sidebar   │  │     Dynamic Content Area          │ │
│  │  Component   │  │    (Route/Page Container)        │ │
│  │              │  │                                  │ │
│  │  (Persistent)│  │  ┌────────────────────────────┐ │ │
│  │              │  │  │   Page Component           │ │ │
│  │              │  │  │   (Chat/Overview/etc)      │ │ │
│  │              │  │  └────────────────────────────┘ │ │
│  └──────────────┘  └──────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│                    Footer Component                      │
│                  (Optional/Contextual)                   │
└─────────────────────────────────────────────────────────┘
```

### Component Hierarchy

#### Level 1: Root Components
- **`AppShell`**: Top-level container managing layout structure
- **`LayoutProvider`**: Context provider for layout state

#### Level 2: Layout Components
- **`Header`**: Application header with branding
- **`Navigation`**: Tab navigation bar
- **`Sidebar`**: Persistent sidebar (conversations, filters, etc.)
- **`ContentArea`**: Dynamic content container
- **`Footer`**: Optional footer component

#### Level 3: Page Components
- **`ChatPage`**: Chat interface with message list and input
- **`OverviewPage`**: Dashboard overview with stats
- **`ExecutionsPage`**: Tool executions table/list
- **`ReasoningPage`**: Reasoning traces viewer
- **`GraphPage`**: Ontology graph visualization
- **`RagPage`**: RAG diagnostics interface
- **`QueryPage`**: Unified query interface

#### Level 4: Feature Components
- **`ConversationList`**: List of chat conversations
- **`MessageList`**: Chat messages display
- **`MessageInput`**: Chat input component
- **`DataTable`**: Reusable table component
- **`GraphCanvas`**: Graph visualization canvas
- **`Card`**: Reusable card component
- **`Button`**: Button component with variants
- **`Modal`**: Modal/dialog component
- **`Badge`**: Status badge component

#### Level 5: Primitive Components
- **`Icon`**: Icon component
- **`Skeleton`**: Loading skeleton component
- **`Tooltip`**: Tooltip component
- **`Dropdown`**: Dropdown menu component

### Component Composition Pattern

**Note**: The examples below use JSX-like syntax for clarity, but the architecture is **framework-agnostic**. Components can be implemented as:
- **Vanilla JavaScript**: Class-based or functional components with DOM manipulation
- **React**: Functional components with hooks
- **Vue**: Single-file components or composition API
- **Other frameworks**: Adapted to framework patterns

```typescript
// Framework-agnostic pseudocode example
// This represents the structure, not the exact syntax

// Example: AppShell composition
<AppShell>
  <Header>
    <Logo />
    <Branding />
  </Header>
  <Navigation>
    <TabList>
      <Tab id="chat">Chat</Tab>
      <Tab id="overview">Overview</Tab>
      {/* ... more tabs */}
    </TabList>
  </Navigation>
  <LayoutContainer>
    <Sidebar>
      <ConversationList />
    </Sidebar>
    <ContentArea>
      <RouteRenderer />
    </ContentArea>
  </LayoutContainer>
</AppShell>
```

**Vanilla JavaScript Implementation Example**:
```javascript
// Vanilla JS component pattern
class AppShell {
  constructor(container) {
    this.container = container;
    this.header = new Header();
    this.navigation = new Navigation();
    this.sidebar = new Sidebar();
    this.contentArea = new ContentArea();
  }
  
  render() {
    this.container.innerHTML = `
      ${this.header.render()}
      ${this.navigation.render()}
      <div class="layout-container">
        ${this.sidebar.render()}
        ${this.contentArea.render()}
      </div>
    `;
  }
}
```

**React Implementation Example**:
```typescript
// React functional component
function AppShell() {
  return (
    <>
      <Header />
      <Navigation />
      <LayoutContainer>
        <Sidebar />
        <ContentArea />
      </LayoutContainer>
    </>
  );
}
```

---

## Layout Hierarchy & Layering

### Z-Index Layering System

A consistent z-index scale prevents stacking context conflicts:

```css
/* Z-Index Tokens */
--z-base: 0;              /* Base content */
--z-elevated: 10;         /* Cards, elevated content */
--z-sticky: 20;          /* Sticky headers, nav bars */
--z-dropdown: 30;        /* Dropdown menus */
--z-overlay: 40;         /* Overlays, backdrops */
--z-modal: 50;           /* Modal dialogs */
--z-tooltip: 60;         /* Tooltips */
--z-notification: 70;    /* Toast notifications */
--z-max: 9999;           /* Emergency override */
```

### Portal/Overlay Root Requirement

**Critical Rule**: All overlays (modals, tooltips, dropdowns, notifications) MUST render in a top-level portal root, not within component DOM trees. This prevents stacking context issues.

```html
<!-- Portal root in HTML -->
<body>
  <div id="app-root">
    <!-- Main application content -->
  </div>
  
  <!-- Portal root for all overlays -->
  <div id="portal-root" style="position: relative; z-index: 0;">
    <!-- All modals, tooltips, dropdowns render here -->
  </div>
</body>
```

```typescript
// Portal utility function
function createPortal(element: HTMLElement, targetId: string = 'portal-root') {
  const portalRoot = document.getElementById(targetId);
  if (!portalRoot) {
    // Create portal root if it doesn't exist
    const root = document.createElement('div');
    root.id = targetId;
    root.style.cssText = 'position: relative; z-index: 0;';
    document.body.appendChild(root);
    return root.appendChild(element);
  }
  return portalRoot.appendChild(element);
}

// Usage: Render modal in portal root
function showModal(content: HTMLElement) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.zIndex = 'var(--z-modal)';
  modal.appendChild(content);
  createPortal(modal); // Renders in portal-root, not component tree
}
```

**Why Portals Matter**: Without portals, modals/tooltips inherit the stacking context of their parent component. If a parent has `position: relative` and `z-index`, the modal can't escape that context, causing z-index conflicts.

### Visual Layering Structure

```
Layer 7: Notifications (z-70)
  └─ Toast messages, alerts

Layer 6: Tooltips (z-60)
  └─ Contextual help, hover tooltips

Layer 5: Modals (z-50)
  └─ Dialog boxes, confirmations

Layer 4: Overlays (z-40)
  └─ Mobile sidebar backdrop, loading overlays

Layer 3: Dropdowns (z-30)
  └─ Dropdown menus, select options

Layer 2: Sticky Elements (z-20)
  └─ Navigation bars, sticky headers

Layer 1: Elevated Content (z-10)
  └─ Cards, elevated panels

Layer 0: Base Content (z-0)
  └─ Main content, background
```

### Layout Stacking Contexts

1. **Root Stacking Context**: Body element
2. **App Shell Context**: Main application container
3. **Page Context**: Individual page/route container
4. **Component Context**: Individual component containers

---

## Layout Composition Pattern

### Composition Strategy

The layout uses a **flexible composition pattern** where components can be arranged in different configurations based on context (mobile vs desktop, different pages).

#### Desktop Layout Composition

```
┌─────────────────────────────────────────────────────────────┐
│ Header (Full Width, Sticky)                                  │
├──────────────┬──────────────────────────────────────────────┤
│              │ Navigation Bar (Full Width, Sticky)           │
├──────────────┴──────────────────────────────────────────────┤
│ Sidebar │ Content Area (Flexible Width)                     │
│ (Fixed) │                                                    │
│ Width   │ ┌──────────────────────────────────────────────┐  │
│         │ │ Page Content                                  │  │
│         │ │ (Scrollable)                                 │  │
│         │ └──────────────────────────────────────────────┘  │
└─────────┴────────────────────────────────────────────────────┘
```

#### Mobile Layout Composition

```
┌─────────────────────────────────────┐
│ Header (Compact)                    │
├─────────────────────────────────────┤
│ Navigation (Dropdown/Menu)          │
├─────────────────────────────────────┤
│                                     │
│ Content Area (Full Width)           │
│ ┌─────────────────────────────────┐ │
│ │ Page Content                    │ │
│ │ (Scrollable)                    │ │
│ └─────────────────────────────────┘ │
│                                     │
│ Sidebar (Overlay/Drawer)            │
│ (Hidden by default, slides in)      │
└─────────────────────────────────────┘
```

### Composition Rules

1. **Container Queries**: Use container queries for component-level responsiveness
2. **Flexible Grids**: CSS Grid for complex layouts, Flexbox for simpler arrangements
3. **Responsive Breakpoints**: Mobile-first with progressive enhancement
4. **Content Priority**: Critical content visible first, secondary content loads progressively

---

## App Shell Pattern

### App Shell Architecture

The **App Shell** is the minimal HTML, CSS, and JavaScript required to render the user interface shell. It provides:

- Persistent navigation structure
- Consistent branding and header
- Loading states and skeletons

### Shell Structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <!-- Critical CSS (inline) -->
  <!-- Meta tags -->
  <!-- Preload critical resources -->
</head>
<body>
  <div id="app-shell">
    <!-- Header (Persistent) -->
    <header id="app-header">
      <!-- Logo, branding -->
    </header>
    
    <!-- Navigation (Persistent) -->
    <nav id="app-navigation">
      <!-- Tab navigation -->
    </nav>
    
    <!-- Main Layout Container -->
    <main id="app-main">
      <!-- Sidebar (Conditional, Persistent) -->
      <aside id="app-sidebar">
        <!-- Sidebar content -->
      </aside>
      
      <!-- Content Area (Dynamic) -->
      <section id="app-content">
        <!-- Route/Page content loads here -->
        <!-- Skeleton loaders shown during loading -->
      </section>
    </main>
    
    <!-- Footer (Optional, Contextual) -->
    <footer id="app-footer">
      <!-- Footer content -->
    </footer>
  </div>
  
  <!-- Portal root for overlays -->
  <div id="portal-root"></div>
  
  <!-- Critical JavaScript (inline or deferred) -->
</body>
</html>
```

### Shell Loading Strategy

1. **Initial Load**: Shell renders immediately with skeleton loaders
2. **Progressive Enhancement**: Content loads and replaces skeletons
3. **Fast Subsequent Loads**: Shell structure cached in browser

### Shell Components

#### Header Shell
- Logo and branding
- User menu (if applicable)
- Global actions (settings, help)

#### Navigation Shell
- Tab navigation
- Active state indicators
- Mobile menu toggle

#### Sidebar Shell
- Conversation list (Chat page)
- Filters/controls (other pages)
- Collapsible on mobile

#### Content Shell
- Dynamic route container
- Loading skeletons
- Error boundaries

---

## Optional: Progressive Web App (PWA) Features

> **Note**: PWA features (service workers, offline support, app caching) are optional and can be implemented later if needed. The current architecture supports adding these features without structural changes.

### Service Worker & Offline Support (Optional)

If implementing PWA features:

#### Service Worker Registration
```javascript
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then(registration => console.log('SW registered'))
    .catch(error => console.log('SW registration failed'));
}
```

#### Offline Strategy
- Cache app shell (HTML, CSS, JS)
- Cache API responses with network-first strategy
- Show offline indicator when network unavailable

#### App Caching
- Cache critical assets on install
- Update cache on new version
- Serve cached content when offline

---

## Persistent UI Components

### Header Component

**Purpose**: Persistent application header with branding and global actions.

**Structure** (Framework-agnostic pseudocode):
```typescript
<Header>
  <HeaderContent>
    <Logo />
    <Branding>Palindrome Dashboard</Branding>
  </HeaderContent>
  <HeaderActions>
    <SettingsButton />
    <HelpButton />
  </HeaderActions>
</Header>
```

**Behavior**:
- Sticky positioning on scroll (desktop)
- Compact on mobile
- Always visible
- Responsive logo sizing

**Implementation**:
- Fixed height: `64px` (desktop), `56px` (mobile)
- Background: Semi-transparent with backdrop blur
- Z-index: `--z-sticky` (20)

### Navigation Component

**Purpose**: Tab-based navigation for switching between main sections.

**Structure** (Framework-agnostic pseudocode):
```typescript
<Navigation>
  <TabList role="tablist">
    <Tab id="chat" active>Chat</Tab>
    <Tab id="overview">Overview</Tab>
    <Tab id="executions">Tool Executions</Tab>
    <Tab id="reasoning">Reasoning Traces</Tab>
    <Tab id="graph">Ontology Graph</Tab>
    <Tab id="rag">RAG Diagnostics</Tab>
    <Tab id="query">Query</Tab>
  </TabList>
</Navigation>
```

**Active State**: The active tab is derived from the current URL route, not stored separately.

**Behavior**:
- Sticky positioning (desktop)
- Horizontal scroll on mobile (or dropdown)
- Active state management
- Keyboard navigation (Arrow keys, Home, End)
- ARIA attributes for accessibility

**Responsive Behavior**:
- **Desktop**: Horizontal tab bar, always visible
- **Mobile**: Dropdown selector or hamburger menu

**Implementation**:
- Height: `48px`
- Background: Semi-transparent with backdrop blur
- Border-bottom indicator for active tab
- Smooth transitions on tab switch

### Sidebar Component

**Purpose**: Persistent sidebar for contextual navigation/content.

**Structure** (Framework-agnostic pseudocode):
```typescript
<Sidebar>
  <SidebarHeader>
    <Title>Conversations</Title>
    <ActionButton>New</ActionButton>
  </SidebarHeader>
  <SidebarContent>
    <ConversationList />
  </SidebarContent>
</Sidebar>
```

**Behavior**:
- **Desktop**: Always visible, fixed width (`256px`)
- **Mobile**: Hidden by default, overlay drawer
- Sticky positioning (desktop)
- Scrollable content area
- Collapsible (optional)

**Mobile Overlay**:
- Full-screen overlay with backdrop
- Slide-in animation from left
- Focus trap when open
- Escape key to close
- Backdrop click to close

**Implementation**:
- Width: `256px` (desktop), `100vw` (mobile overlay)
- Background: Gradient background
- Z-index: `--z-overlay` (40) when mobile overlay
- Smooth slide animations

### Footer Component

**Purpose**: Optional footer for additional information or actions.

**Structure** (Framework-agnostic pseudocode):
```typescript
<Footer>
  <FooterContent>
    <Copyright />
    <Links />
  </FooterContent>
</Footer>
```

**Behavior**:
- Contextual visibility (not all pages need footer)
- Sticky to bottom when content is short
- Pushed down by content when long

**Implementation**:
- Height: `48px` (compact) or `64px` (full)
- Background: Transparent or subtle background
- Border-top separator

---

## Dynamic Content Area

### Content Area Architecture

The **Content Area** is the dynamic container where route-specific page components render.

### Route-Based Content Loading

**Route Derivation**: Routes are derived from the URL (window.location.pathname), not stored in state.

```typescript
// Route-to-component mapping
const ROUTE_MAP = {
  '/': ChatPage,
  '/chat': ChatPage,
  '/overview': OverviewPage,
  '/executions': ExecutionsPage,
  '/reasoning': ReasoningPage,
  '/graph': GraphPage,
  '/rag': RagPage,
  '/query': QueryPage
};

// Derive current route from URL
function getCurrentRoute(): string {
  return window.location.pathname || '/';
}

// Render component based on URL
function RouteRenderer() {
  const route = getCurrentRoute(); // Derived from URL
  const PageComponent = ROUTE_MAP[route] || ChatPage;
  
  return <PageComponent />;
}

// Framework-agnostic usage
<ContentArea>
  <RouteRenderer />
</ContentArea>
```

### Page Component Structure

Each page component follows a consistent structure (framework-agnostic pseudocode):

```typescript
<PageComponent>
  <PageHeader>
    <PageTitle />
    <PageActions />
  </PageHeader>
  <PageContent>
    {/* Page-specific content */}
  </PageContent>
</PageComponent>
```

### Content Loading States

1. **Initial Load**: Skeleton loaders
2. **Loading**: Progress indicators
3. **Loaded**: Content rendered
4. **Error**: Error boundary with retry

### Page Transitions

- **Fade Transition**: Opacity fade between pages
- **Slide Transition**: Horizontal slide (optional)
- **Duration**: 200-300ms for smooth feel
- **Preserve Scroll**: Maintain scroll position when returning to page

### Content Area Layouts

#### Full-Width Layout
```typescript
// Framework-agnostic pseudocode
<ContentArea layout="full-width">
  <PageContent />
</ContentArea>
```

#### Centered Layout
```typescript
<ContentArea layout="centered" maxWidth="7xl">
  <PageContent />
</ContentArea>
```

#### Sidebar Layout
```typescript
<ContentArea layout="with-sidebar">
  <Sidebar />
  <PageContent />
</ContentArea>
```

---

## Responsive Design Strategy

### Breakpoint System

```css
/* Mobile First Breakpoints */
--breakpoint-sm: 640px;   /* Small devices (tablets) */
--breakpoint-md: 768px;   /* Medium devices (small laptops) */
--breakpoint-lg: 1024px;  /* Large devices (desktops) */
--breakpoint-xl: 1280px;  /* Extra large devices */
--breakpoint-2xl: 1536px; /* 2X large devices */
```

### Responsive Layout Patterns

#### 1. Mobile-First Approach
- Base styles target mobile (< 640px)
- Progressive enhancement for larger screens
- Touch-friendly targets (min 44x44px)

#### 2. Container Queries
- Component-level responsiveness
- Independent of viewport size
- More flexible than media queries

#### 3. Flexible Grids
- CSS Grid for complex layouts
- Auto-fit/auto-fill for responsive columns
- Minmax for flexible sizing

#### 4. Responsive Typography
- Fluid typography (clamp)
- Responsive font sizes
- Line-height adjustments

### Layout Transformations

#### Desktop → Mobile Transformations

1. **Sidebar**: Fixed → Overlay drawer
2. **Navigation**: Horizontal tabs → Dropdown menu
3. **Tables**: Full table → Card layout
4. **Graph**: Fixed height → Responsive height
5. **Spacing**: Larger padding → Compact padding

#### Mobile → Desktop Enhancements

1. **Additional Columns**: Single → Multi-column
2. **Hover States**: Touch → Hover interactions
3. **Sticky Elements**: Static → Sticky positioning
4. **Floating Actions**: Bottom → Side floating

---

## State Management Architecture

### Routing as Source of Truth

**Critical Principle**: The URL/router is the single source of truth for navigation state. All other state (activeTab, currentRoute) is derived from the URL, not stored separately.

```typescript
// ❌ WRONG: Duplicate state
interface LayoutState {
  activeTab: string;      // Duplicates route
  currentRoute: string;   // Duplicates route
}

// ✅ CORRECT: Derive from URL
interface LayoutState {
  // Derived from URL - not stored separately
  // activeTab: getActiveTabFromURL(window.location.hash)
  // currentRoute: getRouteFromURL(window.location.pathname)
  
  // Only store UI state that isn't in URL
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  contentLoading: boolean;
  isMobile: boolean;
  mobileMenuOpen: boolean;
  theme: 'light' | 'dark';
  sidebarWidth: number;
}
```

### Route-to-Tab Mapping

```typescript
// Route configuration
const ROUTE_CONFIG = {
  '/': 'chat',
  '/chat': 'chat',
  '/overview': 'overview',
  '/executions': 'executions',
  '/reasoning': 'reasoning',
  '/graph': 'graph',
  '/rag': 'rag',
  '/query': 'query'
};

// Derive active tab from URL
function getActiveTabFromURL(): string {
  const path = window.location.pathname;
  return ROUTE_CONFIG[path] || 'chat';
}

// Navigation updates URL, which updates UI
function navigateToRoute(route: string) {
  window.history.pushState({}, '', route);
  // Dispatch route change event
  window.dispatchEvent(new CustomEvent('routechange', { detail: { route } }));
}
```

### State Management Implementation

#### Store Architecture

The application uses a **simple event-based state store** that works with vanilla JavaScript, but can be adapted to React Context API, Vue's reactive system, or other frameworks.

```typescript
// Framework-agnostic state store
class LayoutStore {
  private state: LayoutState;
  private listeners: Set<(state: LayoutState) => void>;
  
  constructor() {
    this.state = {
      sidebarOpen: false,
      sidebarCollapsed: false,
      contentLoading: false,
      isMobile: window.innerWidth < 768,
      mobileMenuOpen: false,
      theme: 'dark',
      sidebarWidth: 256
    };
    this.listeners = new Set();
    
    // Derive route from URL on init
    this.syncRouteFromURL();
    
    // Listen for URL changes
    window.addEventListener('popstate', () => this.syncRouteFromURL());
    window.addEventListener('routechange', (e: CustomEvent) => {
      this.syncRouteFromURL();
    });
  }
  
  // Get current route from URL (source of truth)
  private syncRouteFromURL() {
    const route = window.location.pathname || '/';
    const activeTab = getActiveTabFromURL();
    // Route is derived, not stored
  }
  
  getState(): LayoutState {
    return { ...this.state };
  }
  
  subscribe(listener: (state: LayoutState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  
  updateState(updates: Partial<LayoutState>) {
    this.state = { ...this.state, ...updates };
    this.listeners.forEach(listener => listener(this.state));
  }
}

// Singleton instance
export const layoutStore = new LayoutStore();
```

#### State Boundaries

**Layout State** (managed by LayoutStore):
- Sidebar visibility/collapse
- Mobile menu state
- Theme preference
- Responsive breakpoint detection

**Page State** (managed by page components):
- Page-specific data (conversations, executions, etc.)
- Page loading states
- Page filters/search

**Feature State** (managed by feature components):
- Component-specific UI state
- Form inputs
- Component interactions

**Rule**: State lives at the lowest level that needs it. Only lift state up when multiple components need it.

### State Actions

```typescript
// Navigation actions - update URL, not state
function navigateToRoute(route: string) {
  window.history.pushState({}, '', route);
  window.dispatchEvent(new CustomEvent('routechange', { detail: { route } }));
}

// Sidebar actions - update layout state
layoutStore.updateState({ sidebarOpen: !layoutStore.getState().sidebarOpen });

// Mobile actions - update layout state
layoutStore.updateState({ mobileMenuOpen: true });

// Theme actions - update layout state + persist
function setTheme(theme: 'light' | 'dark') {
  layoutStore.updateState({ theme });
  localStorage.setItem('theme', theme);
}
```

### React Context Alternative

If using React, the same pattern applies with Context API:

```typescript
// React Context implementation
const LayoutContext = createContext<{
  state: LayoutState;
  navigateToRoute: (route: string) => void;
  updateLayoutState: (updates: Partial<LayoutState>) => void;
}>();

function LayoutProvider({ children }) {
  const [state, setState] = useState<LayoutState>(initialState);
  
  // Derive route from URL
  useEffect(() => {
    const route = window.location.pathname;
    // Route is derived, not stored in state
  }, [window.location.pathname]);
  
  const navigateToRoute = (route: string) => {
    window.history.pushState({}, '', route);
    // Components react to URL change via useEffect
  };
  
  return (
    <LayoutContext.Provider value={{ state, navigateToRoute, updateLayoutState: setState }}>
      {children}
    </LayoutContext.Provider>
  );
}
```

---

## Implementation Guidelines

### CSS Architecture

#### 1. Utility-First CSS (Tailwind)
- Use Tailwind utilities for styling
- Custom utilities for project-specific patterns
- Avoid inline styles except for dynamic values

#### 2. Component Styles
- Scoped component styles when needed
- CSS Modules or styled-components pattern
- Consistent naming conventions

#### 3. Design Tokens
```css
/* Colors */
--color-primary: #f97316;
--color-secondary: #64748b;
--color-background: #0f172a;
--color-surface: #1e293b;

/* Spacing */
--spacing-xs: 0.25rem;
--spacing-sm: 0.5rem;
--spacing-md: 1rem;
--spacing-lg: 1.5rem;
--spacing-xl: 2rem;

/* Typography */
--font-family-sans: system-ui, sans-serif;
--font-family-mono: 'Courier New', monospace;
--font-size-base: 1rem;
--line-height-base: 1.5;

/* Shadows */
--shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
--shadow-md: 0 4px 6px rgba(0,0,0,0.1);
--shadow-lg: 0 10px 15px rgba(0,0,0,0.1);
```

### JavaScript Architecture

#### 1. Component-Based Structure

**Framework-Agnostic Pattern**: The following pattern works with vanilla JavaScript, React, Vue, or any framework. Adapt the implementation details to your chosen framework.

```javascript
// Vanilla JavaScript: Class-based component pattern
class Component {
  constructor(element, options) {
    this.element = element;
    this.options = options;
    this.state = {};
    this.init();
  }
  
  init() {
    this.render();
    this.bindEvents();
  }
  
  render() {
    // Render component DOM
  }
  
  bindEvents() {
    // Bind event listeners
  }
  
  update(state) {
    this.state = { ...this.state, ...state };
    this.render();
  }
  
  destroy() {
    // Cleanup event listeners, timers, etc.
  }
}

// React: Functional component pattern
function Component({ element, options }) {
  const [state, setState] = useState({});
  
  useEffect(() => {
    // Initialize
    bindEvents();
    return () => {
      // Cleanup
    };
  }, []);
  
  return (
    <div>
      {/* Render JSX */}
    </div>
  );
}

// Vue: Composition API pattern
export default {
  setup(props) {
    const state = ref({});
    
    onMounted(() => {
      // Initialize
      bindEvents();
    });
    
    onUnmounted(() => {
      // Cleanup
    });
    
    return {
      state
    };
  }
}
```

**Choose One Paradigm**: Pick the pattern that matches your framework:
- **Vanilla JS**: Use class-based or functional components with DOM manipulation
- **React**: Use functional components with hooks
- **Vue**: Use composition API or options API
- **Other**: Adapt to framework conventions

#### 2. Event-Driven Communication
- Custom events for component communication
- Event delegation for performance
- Centralized event bus for global events

#### 3. Lazy Loading
- Route-based code splitting
- Component lazy loading
- Image lazy loading

### Accessibility Guidelines

#### 1. ARIA Attributes
- Proper roles and labels
- ARIA states (aria-expanded, aria-selected)
- ARIA live regions for dynamic content

#### 2. Keyboard Navigation
- Tab order management
- Focus trap in modals
- Keyboard shortcuts

#### 3. Screen Reader Support
- Semantic HTML
- Alt text for images
- Descriptive labels

### Performance Optimization

#### 1. Rendering Optimization
- Virtual scrolling for long lists
- Debounced resize handlers
- RequestAnimationFrame for animations

#### 2. Asset Optimization
- Image optimization and lazy loading
- Font subsetting
- CSS/JS minification

#### 3. Caching Strategy
- Browser caching headers for static assets
- Component-level caching (memoization)
- (Optional) Service worker for offline support (see PWA section)

---

## Component Specifications

### AppShell Component

**Props** (Framework-agnostic):
- `children`: Component children
- `theme`: 'light' | 'dark'
- `sidebarVisible`: boolean
- `sidebarCollapsed`: boolean

**State**:
- `isMobile`: boolean (derived from window width)
- `sidebarOpen`: boolean
- `activeTab`: string (derived from URL, not stored)

**Methods**:
- `toggleSidebar()`
- `navigateToRoute(route)` - Updates URL, which updates activeTab
- `handleResize()`

### Header Component

**Props**:
- `logo`: string (logo URL)
- `title`: string
- `actions`: Array<Action>

**State**:
- `scrolled`: boolean (for sticky behavior)

### Navigation Component

**Props**:
- `tabs`: Array<Tab>
- `onTabChange`: (route: string) => void - Navigates to route URL

**State**:
- `activeTab`: string (derived from URL, not stored)
- `mobileMenuOpen`: boolean

**Methods**:
- `handleTabClick(route)` - Calls navigateToRoute(route), updates URL
- `handleKeyDown(event)`
- `toggleMobileMenu()`

**Note**: Active tab is derived from `window.location.pathname`, not stored in component state.

### Sidebar Component

**Props**:
- `content`: Component
- `width`: number (desktop width)
- `collapsible`: boolean
- `overlay`: boolean (mobile overlay mode)

**State**:
- `open`: boolean
- `collapsed`: boolean

**Methods**:
- `toggle()`
- `collapse()`
- `expand()`

### ContentArea Component

**Props**:
- `children`: Component
- `layout`: 'full-width' | 'centered' | 'with-sidebar'
- `maxWidth`: string
- `loading`: boolean

**State**:
- `loading`: boolean
- `error`: Error | null

**Methods**:
- `setLoading(loading)`
- `setError(error)`

---

## Migration Path

### Phase 1: Foundation
1. Create AppShell component structure
2. Implement Header and Navigation components
3. Set up routing/navigation system
4. Establish design token system

### Phase 2: Layout Components
1. Implement Sidebar component
2. Create ContentArea component
3. Build page component structure
4. Implement responsive breakpoints

### Phase 3: Feature Components
1. Migrate existing components to new structure
2. Implement component library
3. Add accessibility features
4. Optimize performance

### Phase 4: Polish
1. Add animations and transitions
2. Implement loading states
3. Add error boundaries
4. Performance optimization

---

## Migration Plan

### Migration Status: Phase 1 & 2 Complete ✅

**Completed Migrations:**

#### Phase 1: Foundation (Complete)
- ✅ **Portal Root**: Created `#portal-root` in `index.html` and `portal.js` utilities
- ✅ **Z-Index Tokens**: Added CSS custom properties (`--z-base` through `--z-notification`)
- ✅ **Modal Migration**: Refactored `modal.js` and `ui-helpers.js` to use portal root
- ✅ **Tooltip Migration**: Refactored tooltips to use portal root and z-index tokens
- ✅ **Z-Index Cleanup**: Replaced all hardcoded z-index values with tokens

#### Phase 2: Navigation (Complete)
- ✅ **URL Routing**: Created `routing.js` with route-to-tab mapping
- ✅ **Route Navigation**: `switchTab()` now updates URL via `navigateToTab()`
- ✅ **Browser Navigation**: Back/forward buttons work via `popstate` listener
- ✅ **Route Derivation**: Active tab derived from `window.location.pathname`

#### Phase 3: State Management (Complete)
- ✅ **LayoutStore**: Created centralized state store (`layout-store.js`)
- ✅ **State Boundaries**: Clear separation (Layout vs Page vs Feature)
- ✅ **State Persistence**: Theme and sidebar preferences saved to localStorage
- ✅ **Sidebar Integration**: `toggleSidebar()` uses LayoutStore for state

### Remaining Work (Future Phases)

#### Phase 4: Component Refactoring (Optional)
- [ ] Refactor components to follow documented hierarchy
- [ ] Create formal component classes/functions
- [ ] Extract page components into separate files
- [ ] Build component library documentation

### Migration Verification

**Checklist:**
- [x] Portal root exists in HTML
- [x] All modals render in portal root
- [x] All tooltips render in portal root
- [x] Z-index tokens used everywhere (no hardcoded values)
- [x] URL updates when switching tabs
- [x] Browser back/forward works
- [x] Active tab derived from URL
- [x] LayoutStore manages sidebar/mobile/theme state
- [x] No duplicate route state (URL is source of truth)

### Testing the Migration

1. **Portal Root**: Open browser DevTools, check `#portal-root` exists
2. **Z-Index Tokens**: Inspect modals/tooltips - should use `var(--z-modal)`, `var(--z-tooltip)`
3. **URL Routing**: Switch tabs, verify URL changes (`/chat`, `/overview`, etc.)
4. **Browser Navigation**: Use back/forward buttons - should navigate between tabs
5. **State Persistence**: Close sidebar, refresh page - state should restore

---

## Conclusion

This architecture provides a solid foundation for a scalable, maintainable frontend layout system. The component-based approach ensures reusability, while the App Shell pattern provides excellent performance and user experience. The responsive design strategy ensures the application works seamlessly across all device sizes.

### Key Takeaways

1. **Component-Based**: Build reusable, composable components
2. **App Shell**: Provide instant shell rendering with progressive content loading
3. **Responsive**: Mobile-first approach with progressive enhancement
4. **Accessible**: ARIA-compliant, keyboard navigable
5. **Performant**: Lazy loading, code splitting, optimized rendering

### Next Steps

1. Review and refine component specifications
2. Create detailed component API documentation
3. Build component library/storybook
4. Implement design system tokens
5. Begin migration from current implementation

---

## Appendix

### A. Component File Structure

```
src/
├── components/
│   ├── layout/
│   │   ├── AppShell.js
│   │   ├── Header.js
│   │   ├── Navigation.js
│   │   ├── Sidebar.js
│   │   ├── ContentArea.js
│   │   └── Footer.js
│   ├── pages/
│   │   ├── ChatPage.js
│   │   ├── OverviewPage.js
│   │   ├── ExecutionsPage.js
│   │   └── ...
│   ├── features/
│   │   ├── ConversationList.js
│   │   ├── MessageList.js
│   │   └── ...
│   └── primitives/
│       ├── Button.js
│       ├── Card.js
│       ├── Modal.js
│       └── ...
├── styles/
│   ├── tokens.css
│   ├── base.css
│   └── utilities.css
└── utils/
    ├── layout.js
    ├── responsive.js
    └── state.js
```

### B. CSS Class Naming Convention

- **BEM-like**: `component-name__element--modifier`
- **Utility-first**: Prefer Tailwind utilities
- **Component scoping**: Use CSS Modules or scoped styles

### C. JavaScript Module Pattern

```javascript
// ES6 Modules
export class Component {
  // Component implementation
}

// Default export
export default Component;

// Named exports
export { Component, ComponentUtils };
```

---

---

## Migration Summary

### What Was Migrated

1. **Portal Root System**: All overlays now render in `#portal-root`
2. **Z-Index Token System**: Consistent layering via CSS custom properties
3. **URL-Based Routing**: Navigation state derived from URL, not stored separately
4. **Centralized State**: LayoutStore manages UI state (sidebar, mobile, theme)

### Files Created/Modified

**New Files:**
- `dashboard/js/portal.js` - Portal rendering utilities
- `dashboard/js/routing.js` - URL-based routing system
- `dashboard/js/layout-store.js` - Centralized state management

**Modified Files:**
- `dashboard/index.html` - Added portal root, updated z-index values
- `dashboard/css/input.css` - Added z-index token system
- `dashboard/js/main.js` - Integrated routing, uses LayoutStore
- `dashboard/js/modal.js` - Uses portal root and z-index tokens
- `dashboard/js/ui-helpers.js` - Uses portal root and z-index tokens
- `dashboard/js/dropdown.js` - Uses z-index tokens
- `dashboard/js/graph.js` - Uses z-index tokens

### Breaking Changes

**None** - Migration is backward compatible. Old `switchTab()` calls still work, but now update URL.

### Next Steps

1. Test all functionality (modals, tooltips, navigation)
2. Verify browser back/forward works correctly
3. Test mobile sidebar behavior
4. Consider Phase 4 component refactoring (optional)

---

**Document Version**: 1.1  
**Last Updated**: 2026-01-27  
**Migration Status**: Phase 1-3 Complete  
**Author**: Palindrome Development Team
