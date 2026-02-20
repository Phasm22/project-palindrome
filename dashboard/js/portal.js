/**
 * Portal utilities for rendering overlays in portal root
 * All modals, tooltips, dropdowns must render in #portal-root
 */

const PORTAL_ROOT_ID = 'portal-root';

/**
 * Get or create portal root element
 */
function getPortalRoot() {
  let portalRoot = document.getElementById(PORTAL_ROOT_ID);
  
  if (!portalRoot) {
    // Create portal root if it doesn't exist
    portalRoot = document.createElement('div');
    portalRoot.id = PORTAL_ROOT_ID;
    portalRoot.style.cssText = 'position: relative; z-index: var(--z-max);';
    document.body.appendChild(portalRoot);
  }
  
  return portalRoot;
}

/**
 * Create a portal - renders element in portal root instead of component DOM
 * @param {HTMLElement} element - Element to render in portal
 * @param {string} targetId - Optional target ID (defaults to portal-root)
 * @returns {HTMLElement} - The portal root element
 */
export function createPortal(element, targetId = PORTAL_ROOT_ID) {
  const portalRoot = targetId === PORTAL_ROOT_ID 
    ? getPortalRoot()
    : (document.getElementById(targetId) || getPortalRoot());
  
  portalRoot.appendChild(element);
  return portalRoot;
}

/**
 * Remove element from portal
 * @param {HTMLElement} element - Element to remove
 */
export function removeFromPortal(element) {
  if (element && element.parentNode) {
    element.parentNode.removeChild(element);
  }
}

/**
 * Check if portal root exists
 */
export function portalRootExists() {
  return !!document.getElementById(PORTAL_ROOT_ID);
}
