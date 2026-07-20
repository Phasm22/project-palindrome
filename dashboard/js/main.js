import { loadConversations, loadUserProfile, initProfileSection, sendChatMessage, selectConversation, createNewConversation, deleteConversation, deleteChatMessage, restoreConversation } from './chat.js';
import { loadToolExecutions } from './executions.js';
import { loadReasoningTraces, copyTraceData } from './reasoning.js';
import { loadGraph } from './graph.js';
import { setupQueryInterface, executeQuery, executeGraphQuery, executeCypherQuery } from './query.js';
import { loadOverviewDashboard, loadIngestionStatus } from './overview.js';
import { testRagQuery } from './rag.js';
import { createCustomDropdown, updateDropdown } from './dropdown.js';
import { API_URL, escapeHtml } from './utils.js';
import { navigateToTab, initRouting, getActiveTabFromURL } from './routing.js';
import { layoutStore } from './layout-store.js';

function applyPlatformClasses() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  const isMac = /mac/i.test(platform) && navigator.maxTouchPoints < 2;

  if (isMac) {
    document.documentElement.classList.add("platform-macos");
  }
}

applyPlatformClasses();

function triggerHeaderLogoRipple() {
  const source = document.getElementById('header-logo-source');
  if (!source) return;

  // Keep the current wave intact if another refresh is requested before it
  // finishes. Restarting the pseudo-element mid-flight creates a visible flash.
  if (source.classList.contains('logo-ripple-burst')) return;

  const finishRipple = (event) => {
    if (event?.animationName !== 'logo-illumination-ripple') return;

    window.clearTimeout(cleanupTimer);
    source.classList.remove('logo-ripple-burst');
    source.removeEventListener('animationend', finishRipple);
  };

  source.addEventListener('animationend', finishRipple);
  source.classList.add('logo-ripple-burst');

  // Fallback for browsers that do not emit animationend for pseudo-elements.
  const cleanupTimer = window.setTimeout(() => {
    source.classList.remove('logo-ripple-burst');
    source.removeEventListener('animationend', finishRipple);
  }, 2800);
}

// Check API connection and show helpful message if it fails
async function checkApiConnection() {
  let health = null;
  try {
    const response = await fetch(`${API_URL}/api/pce-health`, { 
      method: 'GET',
      mode: 'cors',
    });
    health = await response.json().catch(() => null);
    if (response.ok && health?.healthy) {
      console.log('PCE API connection successful:', health.apiProxyBase || API_URL);
      removeApiErrorBanner();
      return true;
    }
  } catch (error) {
    console.error('PCE API connection failed:', error);
  }
  
  showApiErrorBanner(health);
  return false;
}

function removeApiErrorBanner() {
  document.getElementById('api-error-banner')?.remove();
}

function showApiErrorBanner(health) {
  removeApiErrorBanner();
  const target = health?.apiProxyBase || 'configured PCE API';
  const detail = health?.error
    || (health?.upstreamStatus ? `Health check returned HTTP ${health.upstreamStatus}.` : 'Health check did not reach the PCE API.');

  // Show connection error banner
  const banner = document.createElement('div');
  banner.id = 'api-error-banner';
  banner.innerHTML = `
    <div style="
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: linear-gradient(135deg, #7f1d1d 0%, #991b1b 100%);
      color: white;
      padding: 12px 20px;
      z-index: var(--z-notification);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      font-size: 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    ">
      <div style="display: flex; align-items: center; gap: 12px;">
        <div>
          <strong>PCE API unavailable</strong>
          <span style="opacity: 0.9;">${escapeHtml(target)}</span>
          <div style="font-size: 12px; opacity: 0.9; margin-top: 2px;">
            ${escapeHtml(detail)} Make sure the PCE API service is running and PCE_API_URL is correct.
          </div>
        </div>
      </div>
      <button onclick="this.parentElement.parentElement.remove(); checkApiConnection();" style="
        background: rgba(255,255,255,0.2);
        border: none;
        color: white;
        padding: 6px 12px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
      ">Retry</button>
    </div>
  `;
  document.body.prepend(banner);
}

// Expose for retry button
window.checkApiConnection = checkApiConnection;

// Make functions globally accessible for onclick handlers
window.loadToolExecutions = loadToolExecutions;
window.loadReasoningTraces = loadReasoningTraces;
window.copyTraceData = copyTraceData;
window.loadGraph = loadGraph;
window.sendChatMessage = sendChatMessage;
window.selectConversation = selectConversation;
window.createNewConversation = createNewConversation;
window.deleteConversation = deleteConversation;
window.deleteChatMessage = deleteChatMessage;
window.executeQuery = executeQuery;
window.executeGraphQuery = executeGraphQuery;
window.executeCypherQuery = executeCypherQuery;
window.testRagQuery = testRagQuery;
window.loadOverviewDashboard = loadOverviewDashboard;
window.loadIngestionStatus = loadIngestionStatus;

/**
 * Update UI to show a specific tab (internal function - updates DOM only)
 * This is called by route change handlers, not directly
 */
function updateTabUI(tabName, clickedElement = null, animate = true) {
  // Get the target tab content first
  const targetTabContent = document.getElementById(tabName);
  
  // Update tab button states with ARIA
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.remove('active', 'text-primary-500', 'border-primary-500', 'font-semibold');
    t.classList.add('text-slate-400', 'border-transparent', 'font-medium');
    t.setAttribute('aria-selected', 'false');
    t.setAttribute('tabindex', '-1');
  });
  
  // Show selected tab button with ARIA
  const activeTab = clickedElement || Array.from(document.querySelectorAll('.tab')).find(t => 
    t.textContent.trim().toLowerCase().includes(tabName.toLowerCase())
  );
  
  if (activeTab) {
    activeTab.classList.remove('text-slate-400', 'border-transparent', 'font-medium');
    activeTab.classList.add('active', 'text-primary-500', 'border-primary-500', 'font-semibold');
    activeTab.setAttribute('aria-selected', 'true');
    activeTab.setAttribute('tabindex', '0');
  }
  
  // Hide all tab contents except the target with ARIA
  document.querySelectorAll('.tab-content').forEach(c => {
    if (c !== targetTabContent) {
      c.setAttribute('aria-hidden', 'true');
      // Only hide if it's currently visible
      if (animate && !c.classList.contains('hidden')) {
        c.style.transition = 'opacity 0.2s ease-out, transform 0.2s ease-out';
        c.style.opacity = '0';
        c.style.transform = 'translateY(10px)';
        setTimeout(() => {
          c.classList.add('hidden');
          c.classList.remove('flex', 'flex-col');
          // Reset styles after hiding
          c.style.opacity = '';
          c.style.transform = '';
          c.style.transition = '';
        }, 200);
      } else {
        // Initial routing is applied synchronously so the default Chat panel
        // cannot linger while a different URL-selected tab is shown.
        c.classList.add('hidden');
        c.classList.remove('flex', 'flex-col');
        c.style.opacity = '';
        c.style.transform = '';
        c.style.transition = '';
      }
    }
  });
  
  // Show target tab content with ARIA
  if (targetTabContent) {
    const wasHidden = targetTabContent.classList.contains('hidden');
    
    // Remove hidden class and add flex classes first
    targetTabContent.classList.remove('hidden');
    targetTabContent.classList.add('flex', 'flex-col');
    targetTabContent.setAttribute('aria-hidden', 'false');
    
    // Only animate if it was previously hidden
    if (wasHidden && animate) {
      // Set initial state for animation
      targetTabContent.style.opacity = '0';
      targetTabContent.style.transform = 'translateY(10px)';
      targetTabContent.style.transition = 'opacity 0.3s ease-out, transform 0.3s ease-out';
      
      // Force a reflow to ensure the initial state is applied
      targetTabContent.offsetHeight;
      
      // Animate in
      requestAnimationFrame(() => {
        targetTabContent.style.opacity = '1';
        targetTabContent.style.transform = 'translateY(0)';
        
        // Clean up styles after animation completes
        setTimeout(() => {
          // IMPORTANT: remove transform/opacity so we don't create a transformed containing block.
          // Transformed ancestors break `position: fixed` (it becomes fixed-to-ancestor instead of viewport).
          targetTabContent.style.transition = '';
          targetTabContent.style.opacity = '';
          targetTabContent.style.transform = '';
        }, 300);
      });
    } else {
      // Already visible, just ensure it's fully opaque
      targetTabContent.style.opacity = '1';
      targetTabContent.style.transform = 'translateY(0)';
      // Don't leave a transform on the element (same reason as above).
      setTimeout(() => {
        targetTabContent.style.opacity = '';
        targetTabContent.style.transform = '';
      }, 0);
    }
  }
  
  // Load data for the tab
  if (tabName === 'overview') {
    loadOverviewDashboard();
  }
  if (tabName === 'executions') loadToolExecutions();
  if (tabName === 'reasoning') loadReasoningTraces();
  if (tabName === 'graph') {
    loadGraph();
  } else {
    // Cleanup graph tooltips when switching away from graph tab
    const existingTooltips = document.querySelectorAll('.graph-tooltip');
    existingTooltips.forEach(tooltip => tooltip.remove());
  }
  if (tabName === 'query') setupQueryInterface();
  if (tabName === 'chat') {
    // Load conversations and profile when switching to chat tab
    loadConversations();
    loadUserProfile();
    // Focus chat input when switching to chat tab
    setTimeout(() => {
      const chatInput = document.getElementById('chat-input');
      if (chatInput) chatInput.focus();
    }, 100);
  }
  
  // Show/hide floating nav for overview tab (desktop only)
  const overviewNav = document.getElementById('overview-nav');
  if (overviewNav) {
    if (tabName === 'overview' && window.innerWidth >= 768) {
      // Show on desktop when overview tab is active
      overviewNav.classList.remove('hidden');
      overviewNav.classList.add('flex');
    } else {
      // Hide on all other tabs or on mobile
      overviewNav.classList.add('hidden');
      overviewNav.classList.remove('flex');
    }
  }
  
  // Update nav height after visibility changes
  updateChatNavOffset();
  
  // Update mobile dropdown selector
  updateDropdown(tabName);
}

// Keep sticky offsets synced with app header height
function updateChatNavOffset() {
  const header = document.getElementById('app-header');
  const height = header ? Math.round(header.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--chat-nav-height', `${height}px`);
}

/**
 * Switch to a tab - updates URL (source of truth) which triggers UI update
 * @param {string} tabName - Tab ID to switch to
 * @param {HTMLElement} clickedElement - Optional clicked element for UI update
 */
window.switchTab = function(tabName, clickedElement) {
  // Update URL - this will trigger route change event
  navigateToTab(tabName);
  
  // Update UI immediately (will also be called by route change handler, but immediate update is smoother)
  updateTabUI(tabName, clickedElement);
};

// Mobile tab switching function - same as switchTab (updates URL)
window.switchTabMobile = function(tabName) {
  window.switchTab(tabName, null);
};

// Chat input keydown handler - mobile: Enter = new line, desktop: Enter = send
window.handleChatInputKeydown = function(event) {
  // Check if mobile device (touch screen and small width)
  const isMobile = window.innerWidth < 768 || ('ontouchstart' in window);
  
  if (event.key === 'Enter') {
    if (isMobile) {
      // On mobile: Enter always creates new line (default behavior)
      // Don't prevent default, let Enter work normally
      return;
    } else {
      // On desktop: Enter sends, Shift+Enter creates new line
      if (!event.shiftKey) {
        event.preventDefault();
        sendChatMessage();
      }
      // If Shift+Enter, let it create new line (default behavior)
    }
  }
};

// Conversations sidebar removed (simpler header controls + dropdown)

// Load initial data when page loads
window.addEventListener('DOMContentLoaded', async () => {
  // Initialize routing - URL is source of truth
  initRouting(({ route, tabId, source }) => {
    // Update UI when route changes (from URL, browser back/forward, or programmatic)
    updateTabUI(tabId, null, source !== 'init');
    if (source === 'init') {
      document.documentElement.classList.remove('dashboard-routing-pending');
      delete document.documentElement.dataset.initialTab;
    }
  });

  // Initialize sticky offsets and keep them in sync
  updateChatNavOffset();
  window.addEventListener('resize', updateChatNavOffset);
  // Re-check after fonts/images/layout settle
  setTimeout(updateChatNavOffset, 500);
  
  // Initialize custom dropdown for mobile tabs - use current route
  const currentTab = getActiveTabFromURL();
  createCustomDropdown('mobile-tab-dropdown-container', currentTab);

  // Bind profile section Save button and load profile when chat is shown
  initProfileSection();

  // Sync initial nav height offset
  updateChatNavOffset();
  
  // Ensure URL matches current tab (in case page loaded without hash/route)
  const currentRoute = window.location.pathname;
  if (currentRoute === '/' || !currentRoute || currentRoute === '/index.html') {
    // Default to chat if no route specified
    navigateToTab('chat', true); // Use replaceState for initial load
  }
  
  // Initialize icons
  const { createIcon } = await import('./icons.js');
  
  // Header logo - check if logo exists, otherwise use fallback icon (chat tab)
  const headerLogo = document.getElementById('header-logo-chat') || document.getElementById('header-logo');
  const headerIconFallback = document.getElementById('header-icon-fallback-chat') || document.getElementById('header-icon-fallback');
  
  if (headerLogo) {
    // Check if logo loaded successfully
    headerLogo.addEventListener('error', () => {
      console.warn('Logo not found, using fallback icon');
      if (headerIconFallback) {
        headerIconFallback.classList.remove('hidden');
        const icon = createIcon('Clock', { size: 24, color: '#f97316', animation: 'pulse' });
        headerIconFallback.appendChild(icon);
      }
    });
    
    // If logo loads successfully, add animation
    headerLogo.addEventListener('load', () => {
      headerLogo.classList.add('logo-animated');
      console.log('Logo loaded successfully with animations');
    });
    
    // Check if already loaded (cached)
    if (headerLogo.complete && headerLogo.naturalHeight !== 0) {
      headerLogo.classList.add('logo-animated');
    }
  } else if (headerIconFallback) {
    // Fallback if logo element doesn't exist
    headerIconFallback.classList.remove('hidden');
    const icon = createIcon('Clock', { size: 24, color: '#f97316', animation: 'pulse' });
    headerIconFallback.appendChild(icon);
  }
  
  // Refresh icons - use logo component
  const { createLogo } = await import('./components.js');
  const refreshIcons = ['refresh-icon-executions', 'refresh-icon-reasoning', 'refresh-icon-graph', 'refresh-icon-ingestion'];
  refreshIcons.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const logo = createLogo({ 
        size: 42, 
        className: 'logo-refresh',
        spinOnClick: false
      });
      logo.style.display = 'block';
      logo.style.flexShrink = '0';
      el.appendChild(logo);
    }
  });

  // Some refresh buttons (including Overview) are rendered after startup.
  // Delegation ensures every refresh action gets the same header ripple.
  document.addEventListener('click', (event) => {
    if (event.target.closest('button.refresh-button')) {
      triggerHeaderLogoRipple();
    }
  });
  
  // Plus icon
  const plusIcon = document.getElementById('plus-icon');
  if (plusIcon) {
    const icon = createIcon('Plus', { size: 14, color: 'currentColor' });
    plusIcon.appendChild(icon);
  }
  
  // Send icons (mobile + desktop)
  const sendIcon = document.getElementById('send-icon');
  if (sendIcon) {
    const icon = createIcon('Send', { size: 16, color: 'currentColor' });
    sendIcon.appendChild(icon);
  }
  
  const sendIconDesktop = document.getElementById('send-icon-desktop');
  if (sendIconDesktop) {
    const icon = createIcon('Send', { size: 18, color: 'currentColor' });
    sendIconDesktop.appendChild(icon);
  }
  
  // Scroll to bottom button icon
  const scrollToBottomIcon = document.getElementById('scroll-to-bottom-icon');
  if (scrollToBottomIcon) {
    const icon = createIcon('ChevronDown', { size: 20, color: 'currentColor' });
    scrollToBottomIcon.appendChild(icon);
    
    // Initialize button visibility check after a delay
    setTimeout(() => {
      const btn = document.getElementById('scroll-to-bottom-btn');
      if (btn) {
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const windowHeight = window.innerHeight;
        const documentHeight = document.documentElement.scrollHeight;
        const distanceFromBottom = documentHeight - (scrollTop + windowHeight);
        const threshold = Math.max(windowHeight, 200);
        if (distanceFromBottom > threshold) {
          btn.classList.remove('hidden');
        } else {
          btn.classList.add('hidden');
        }
      }
    }, 500);
  }
  
  // Navigation icons for overview (desktop floating nav)
  const navIconStats = document.getElementById('nav-icon-stats');
  if (navIconStats) {
    const icon = createIcon('BarChart3', { size: 20, color: '#f97316' });
    navIconStats.appendChild(icon);
  }
  
  const navIconCluster = document.getElementById('nav-icon-cluster');
  if (navIconCluster) {
    const icon = createIcon('Server', { size: 20, color: '#f97316' });
    navIconCluster.appendChild(icon);
  }
  
  // Add page load animations only for visible elements
  document.querySelectorAll('.tab-content').forEach((el) => {
    // Only animate visible tab content (chat tab by default)
    if (!el.classList.contains('hidden')) {
      el.style.opacity = '0';
      el.style.transform = 'translateY(20px)';
      setTimeout(() => {
        el.style.transition = 'opacity 0.5s ease-out, transform 0.5s ease-out';
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
        // Clean up after animation
        setTimeout(() => {
          // IMPORTANT: clear transform so we don't break fixed positioning.
          el.style.transition = '';
          el.style.opacity = '';
          el.style.transform = '';
        }, 500);
      }, 100);
    }
  });
  
  // Animate cards with stagger
  document.querySelectorAll('.card-elevated').forEach((el, idx) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    setTimeout(() => {
      el.style.transition = 'opacity 0.5s ease-out, transform 0.5s ease-out';
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
      // Clean up after animation
      setTimeout(() => {
        el.style.transition = '';
      }, 500);
    }, idx * 50 + 200);
  });
  
  // Check API connection first
  const apiOk = await checkApiConnection();
  if (!apiOk) {
    console.warn('API connection failed - some features may not work');
  }
  
  // Load data for current tab (derived from URL)
  const activeTab = getActiveTabFromURL();
  if (activeTab === 'chat') {
    loadConversations();
    updateChatNavOffset();
  } else if (activeTab === 'overview') {
    loadOverviewDashboard();
  }
  
  // Restore last active conversation from backend
  // restoreConversation now handles selection internally
  await restoreConversation();
  
  // Load overview data in background (if not already loaded)
  if (activeTab !== 'overview') {
    loadOverviewDashboard();
  }
});

// Auto-refresh every 30 seconds
setInterval(() => {
  const activeTab = getActiveTabFromURL();
  if (activeTab === 'overview') {
    loadOverviewDashboard();
  }
}, 30000);
