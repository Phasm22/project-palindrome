/**
 * URL-based routing utilities
 * Routes are derived from URL - URL is the source of truth
 */

// Route configuration - maps URL paths to tab IDs
export const ROUTE_CONFIG = {
  '/': 'chat',
  '/chat': 'chat',
  '/overview': 'overview',
  '/executions': 'executions',
  '/reasoning': 'reasoning',
  '/graph': 'graph',
  '/rag': 'rag',
  '/query': 'query'
};

// Reverse mapping - tab ID to route
export const TAB_TO_ROUTE = {
  'chat': '/chat',
  'overview': '/overview',
  'executions': '/executions',
  'reasoning': '/reasoning',
  'graph': '/graph',
  'rag': '/rag',
  'query': '/query'
};

/**
 * Get current route from URL
 * @returns {string} Current route path
 */
export function getCurrentRoute() {
  return window.location.pathname || '/';
}

/**
 * Get active tab ID from current URL
 * @returns {string} Active tab ID
 */
export function getActiveTabFromURL() {
  const route = getCurrentRoute();
  return ROUTE_CONFIG[route] || 'chat';
}

/**
 * Navigate to a route (updates URL)
 * @param {string} route - Route path (e.g., '/chat', '/overview')
 * @param {boolean} replace - If true, use replaceState instead of pushState
 */
export function navigateToRoute(route, replace = false) {
  const fullRoute = route.startsWith('/') ? route : `/${route}`;
  
  if (replace) {
    window.history.replaceState({ route: fullRoute }, '', fullRoute);
  } else {
    window.history.pushState({ route: fullRoute }, '', fullRoute);
  }
  
  // Dispatch route change event
  window.dispatchEvent(new CustomEvent('routechange', { 
    detail: { route: fullRoute, tabId: ROUTE_CONFIG[fullRoute] || 'chat' }
  }));
}

/**
 * Navigate to a tab (converts tab ID to route)
 * @param {string} tabId - Tab ID (e.g., 'chat', 'overview')
 * @param {boolean} replace - If true, use replaceState instead of pushState
 */
export function navigateToTab(tabId, replace = false) {
  const route = TAB_TO_ROUTE[tabId] || '/chat';
  navigateToRoute(route, replace);
}

/**
 * Initialize routing - listen for browser back/forward
 * @param {Function} onRouteChange - Callback when route changes
 */
export function initRouting(onRouteChange) {
  // Handle browser back/forward
  window.addEventListener('popstate', (event) => {
    const route = getCurrentRoute();
    const tabId = getActiveTabFromURL();
    if (onRouteChange) {
      onRouteChange({ route, tabId, source: 'popstate' });
    }
  });
  
  // Handle programmatic route changes
  window.addEventListener('routechange', (event) => {
    const { route, tabId } = event.detail;
    if (onRouteChange) {
      onRouteChange({ route, tabId, source: 'programmatic' });
    }
  });
  
  // Initial route sync
  const route = getCurrentRoute();
  const tabId = getActiveTabFromURL();
  if (onRouteChange) {
    onRouteChange({ route, tabId, source: 'init' });
  }
}
