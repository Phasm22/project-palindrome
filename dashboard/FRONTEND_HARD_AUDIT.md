### 1. Executive Summary (Brutally Honest)
- The dashboard is driven by a sprawling inline `<style>` block plus ad-hoc JS mutations, producing conflicting spacing, elevation, and typography that bypass Tailwind’s token system and create an amateur, theme-inconsistent feel.
- Mobile is an afterthought: fixed heights, hidden content, and duplicated state toggles create dead zones, overlays that leak scroll, and canvases that routinely render off-screen or blur on high-DPI devices.
- The graph and table surfaces are desktop-hardcoded (800px shells, 20rem sidebars, display:none tables) with no responsive measurement or DPR handling, so interaction and visibility collapse on phones.

### 2. Systemic Design Faults
- **CSS system failures:** A 250+ line `<style>` in `index.html` defines gradients, shadows, tables, and badges independent of Tailwind utilities, causing token drift, duplicate typography, and inconsistent elevation across the app.【F:index.html†L16-L266】
- **JS UI ownership failures:** Tab and sidebar state mutate inline styles, add/remove classes, and rely on `setTimeout` animations without a single controller, leading to racey hides/shows and duplicated scroll locking between desktop and mobile flows.【F:js/main.js†L23-L194】
- **State synchronization failures:** Mobile tab switching calls `switchTabMobile` → `switchTab`, double-applying class/transition logic and risking stale inline transforms; scroll lock is only managed inside `toggleSidebar`, leaving other overlays unrestricted.【F:js/main.js†L154-L194】
- **Mobile handling failures:** Layout depends on fixed `h-[60dvh]/600px/800px` graph shells and fixed paddings, with hidden tables under 768px and sticky chat inputs that ignore keyboard or safe-area insets.【F:index.html†L403】【F:index.html†L184-L197】【F:index.html†L597-L613】

### 3. Mobile Failure Report
- **Visual bugs:** The graph container stacks 60dvh/600px/800px heights, so on short viewports the canvas is clipped or pushes content off-screen; the legend sidebar remains 20rem wide, forcing horizontal overflow and zero-width canvases on narrow devices.【F:index.html†L403】【F:js/graph.js†L153-L188】
- **Interaction failures:** Graph touch targets aren’t scaled for DPR and lack resize/pixel-ratio handling; click/tap hitboxes shrink on high-DPI phones and there is no orientation or viewport recalculation.【F:js/graph.js†L338-L368】【F:js/graph.js†L312-L434】
- **Scroll failures:** Chat and overview sections place sticky/fixed controls inside nested scroll areas, creating dead zones when the mobile keyboard opens; graph/tables introduce double scroll due to nested fixed heights without `min-h-0` parents.【F:index.html†L590-L613】【F:index.html†L277-L357】【F:index.html†L403】
- **Keyboard/viewport failures:** No safe-area padding on fixed buttons and navs; sticky chat input and bottom nav buttons can collide with iOS home indicators and virtual keyboards, and there is no `env(safe-area-inset-*)` usage.【F:index.html†L277-L357】【F:index.html†L597-L613】
- **Data loss on mobile:** Tables are set to `display:none` below 768px with no inline replacement in the same flow, so datasets vanish unless JS renders alternative cards elsewhere.【F:index.html†L184-L197】【F:js/utils.js†L36-L52】

### 4. Graph Rendering Failure Analysis
- **Invisible graphs:** Graph layout is hardcoded to 800px tall flex children and a 20rem sidebar; on mobile the canvas can be pushed out of view or shrink to near-zero width due to rigid sizing and no min-height/overflow strategy.【F:js/graph.js†L153-L188】
- **Non-interactive graphs:** Sigma is instantiated without reading `window.devicePixelRatio` or resizing the renderer on container changes; high-DPI devices render blurry nodes with reduced hitboxes and there is no resize observer or `sigma.refresh()` hook on viewport/orientation changes.【F:js/graph.js†L338-L368】【F:js/graph.js†L312-L434】
- **Sizing & resolution failures:** Canvas container uses inline heights (800px) and lacks `%`/flex-based scaling; combined with `h-[60dvh]/600px/800px` wrapper on the parent, the rendered surface desyncs from visible area and can be occluded by headers/footers.【F:index.html†L403】【F:js/graph.js†L153-L188】
- **Container measurement failures:** Layout builds the entire graph DOM, then waits 100ms before `initSigma()` without any measurement or ResizeObserver, so the initial camera sizing uses stale dimensions and never updates after tab switches or sidebar toggles.【F:js/graph.js†L264-L305】【F:js/main.js†L48-L152】

### 5. Sidebar & Overlay Failure Analysis
- **Desktop misplacement:** Floating navs and sidebars share the global stacking context (`z-50` fixed elements) with no z-index tokens or isolation; inline drop-shadows and gradients compete visually, and navs can overlap tab content or each other.【F:index.html†L277-L357】【F:index.html†L516-L615】
- **Mobile overlay bugs:** `toggleSidebar` only toggles `hidden`/`flex` and body overflow for the chat sidebar; tab switches can leave the backdrop state inconsistent, and there is no focus trap or Escape handling, so background remains interactive.【F:js/main.js†L173-L194】【F:index.html†L550-L585】
- **Scroll leakage:** Scroll lock is applied only when opening the chat sidebar; other overlays (graph tooltips, search dropdowns) append to `body` without inert/lock, allowing background scroll during overlays.【F:js/main.js†L173-L194】【F:js/graph.js†L436-L501】

### 6. Table Responsiveness Failure Analysis
- Tables are entirely hidden under 768px via CSS with no in-flow replacement, so mobile users lose table data unless JS re-renders elsewhere; there is no horizontal scroll wrapper to preserve columns on mid-width devices.【F:index.html†L184-L197】【F:js/utils.js†L36-L52】
- Table markup inherits desktop padding and borders but nests inside overflow-y containers, causing horizontal scrollbars and clipped content on medium screens because widths aren’t constrained or wrapped in `overflow-x-auto` divs.【F:index.html†L156-L183】【F:js/overview.js†L34-L57】

### 7. Modal System Audit
- Overlays (chat sidebar, graph tooltips, search results) are ad-hoc DOM nodes without `role="dialog"`, `aria-modal`, focus management, or Escape handling; only the sidebar toggles body overflow, leaving other overlays interactive and leaking stacking contexts.【F:index.html†L550-L585】【F:js/graph.js†L436-L501】【F:js/main.js†L173-L194】
- Tooltips are appended to `body` with fixed absolute positioning and no cleanup beyond `remove()`, lacking accessible semantics and creating potential scroll bleed when combined with page scroll.【F:js/graph.js†L436-L501】

### 8. Exact Remediation Blueprint
- **Layout structure:** Remove the inline `<style>` block and migrate tokens into Tailwind config; wrap the graph area in a responsive column layout that stacks sidebar below the canvas under `md`, using `min-h-0` flex parents and `h-[70vh]` desktop / `min-h-[50vh]` mobile without hardcoded px heights.【F:index.html†L16-L266】【F:index.html†L403】【F:js/graph.js†L153-L188】
- **CSS system:** Centralize spacing, radius, shadow, and gradient scales in Tailwind; replace custom scrollbar/badge/table styles with utility-driven classes; enforce a single typography scale to eliminate inline gradients and drop-shadows on headers.【F:index.html†L16-L266】
- **JS boundaries:** Introduce a unified tab/state controller that manages visibility, transitions, and scroll lock with ARIA updates; replace inline style animations with class toggles and remove duplicated mobile/desktop tab paths; add ResizeObserver for the graph container and re-run `sigma.refresh()` with DPR-aware sizing on size/orientation changes.【F:js/main.js†L23-L194】【F:js/graph.js†L312-L434】
- **Mobile-first containment:** Add safe-area padding for fixed buttons/navs, convert sticky chat input to a flex child with `min-h-0` scrolling, and ensure cards/tables use `overflow-auto` with horizontal scroll wrappers instead of hiding tables; avoid `display:none` fallbacks that drop data.【F:index.html†L277-L357】【F:index.html†L597-L613】【F:index.html†L184-L197】
- **Graph container rules:** Use flex or grid with `%` heights and a single responsive breakpoint; compute `const dpr = window.devicePixelRatio || 1` and pass `pixelRatio`/renderer resizing to Sigma; debounce container resize to re-fit camera and controls; ensure controls/sidebars are touch-friendly (44px) and safe-area aware.【F:js/graph.js†L338-L434】【F:js/graph.js†L153-L188】
- **Sidebar architecture:** Replace ad-hoc sidebar/backdrop with a reusable overlay service that sets `aria-modal`, traps focus, locks scroll (including restoring on close), and shares open state between desktop and mobile while honoring safe areas; define z-index tokens for nav/overlay layers to avoid collisions.【F:js/main.js†L173-L194】【F:index.html†L550-L585】
- **Modal system:** Implement a modal controller (or use `<dialog>` polyfill) with focus trap, Escape, inert background, and consistent stacking; migrate graph search/results, chat confirmations, and any future dialogs to this system instead of inline nodes.【F:js/graph.js†L436-L657】【F:js/ui-helpers.js†L6-L200】

### 9. Refactor Priority Order
1) Eliminate inline CSS and hardcoded graph/table dimensions; rebuild responsive layout shells with Tailwind tokens and overflow-safe containers.
2) Add graph measurement + DPR handling (ResizeObserver + `sigma.refresh()` + pixel ratio) and responsive stacking for sidebar/legend.
3) Centralize tab/sidebar state with accessibility (ARIA, focus, Escape) and consistent scroll locking/safe-area padding.
4) Restore mobile data visibility by replacing `display:none` tables with scrollable wrappers or card renders inside the same flow.
5) Introduce a reusable modal/overlay framework and migrate tooltips/search/sidebar to it; normalize typography/shadow scales afterwards.

### 10. Professional Grade Verdict
- The current layout is salvageable only with a targeted layout/state reset: migrate styling to Tailwind tokens, rebuild responsive graph/table shells, and add proper overlay/state management. Incremental tweaks atop the existing inline styles and hardcoded heights will continue to break mobile and graph interactions.

**Verification limitations:** No live devices or browser emulation were run in this environment; findings are source-based and reflect the current code structure and constraints shown above.
