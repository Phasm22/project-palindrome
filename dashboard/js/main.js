import { loadConversations, sendChatMessage, selectConversation, createNewConversation, deleteConversation, deleteChatMessage } from './chat.js';
import { loadToolExecutions } from './executions.js';
import { loadReasoningTraces } from './reasoning.js';
import { loadGraph } from './graph.js';
import { setupQueryInterface, executeQuery, executeGraphQuery, executeCypherQuery } from './query.js';
import { loadExecutionStats, loadClusterStatus, loadSystemHealth } from './overview.js';
import { testRagQuery } from './rag.js';
import { createCustomDropdown, updateDropdown } from './dropdown.js';

// Make functions globally accessible for onclick handlers
window.loadToolExecutions = loadToolExecutions;
window.loadReasoningTraces = loadReasoningTraces;
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

// Make switchTab globally accessible
window.switchTab = function(tabName, clickedElement) {
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
      if (!c.classList.contains('hidden')) {
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
        // Already hidden, just make sure it stays hidden
        c.classList.add('hidden');
        c.classList.remove('flex', 'flex-col');
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
    if (wasHidden) {
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
          targetTabContent.style.transition = '';
        }, 300);
      });
    } else {
      // Already visible, just ensure it's fully opaque
      targetTabContent.style.opacity = '1';
      targetTabContent.style.transform = 'translateY(0)';
    }
  }
  
  // Load data for the tab
  if (tabName === 'overview') {
    loadExecutionStats();
    loadClusterStatus();
    loadSystemHealth();
  }
  if (tabName === 'executions') loadToolExecutions();
  if (tabName === 'reasoning') loadReasoningTraces();
  if (tabName === 'graph') loadGraph();
  if (tabName === 'query') setupQueryInterface();
  if (tabName === 'chat') {
    // Load conversations when switching to chat tab
    loadConversations();
    // Close sidebar on mobile when switching to chat (if open)
    if (window.innerWidth < 768) {
      const sidebarMobile = document.getElementById('conversation-sidebar-mobile');
      const backdrop = document.getElementById('sidebar-backdrop');
      if (sidebarMobile && !sidebarMobile.classList.contains('hidden')) {
        window.toggleSidebar();
      }
    }
    // Focus chat input when switching to chat tab
    setTimeout(() => {
      const chatInput = document.getElementById('chat-input');
      if (chatInput) chatInput.focus();
    }, 100);
  }
  
  // Show/hide floating nav for overview tab (desktop)
  const overviewNav = document.getElementById('overview-nav');
  if (overviewNav) {
    overviewNav.style.display = tabName === 'overview' ? 'flex' : 'none';
  }
  
  // Show/hide mobile nav for overview tab
  const overviewNavMobile = document.getElementById('overview-nav-mobile');
  if (overviewNavMobile) {
    overviewNavMobile.style.display = tabName === 'overview' ? 'flex' : 'none';
  }
  
  // Update mobile dropdown selector
  updateDropdown(tabName);
};

// Mobile tab switching function
window.switchTabMobile = function(tabName) {
  // Use the main switchTab function which handles everything
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

// Sidebar toggle function
window.toggleSidebar = function() {
  const sidebarMobile = document.getElementById('conversation-sidebar-mobile');
  const backdrop = document.getElementById('sidebar-backdrop');
  
  if (sidebarMobile && backdrop) {
    const isHidden = sidebarMobile.classList.contains('hidden');
    if (isHidden) {
      sidebarMobile.classList.remove('hidden');
      sidebarMobile.classList.add('flex');
      backdrop.classList.remove('hidden');
      // Lock body scroll on mobile
      document.body.classList.add('overflow-hidden');
    } else {
      sidebarMobile.classList.add('hidden');
      sidebarMobile.classList.remove('flex');
      backdrop.classList.add('hidden');
      // Restore body scroll
      document.body.classList.remove('overflow-hidden');
    }
  }
};

// Load initial data when page loads
window.addEventListener('DOMContentLoaded', async () => {
  // Initialize custom dropdown for mobile tabs
  createCustomDropdown('mobile-tab-dropdown-container', 'chat');
  
  // Initialize icons
  const { createIcon } = await import('./icons.js');
  
  // Header icon
  const headerIcon = document.getElementById('header-icon');
  if (headerIcon) {
    const icon = createIcon('Clock', { size: 24, color: '#f97316', animation: 'pulse' });
    headerIcon.appendChild(icon);
  }
  
  // Refresh icons
  const refreshIcons = ['refresh-icon-executions', 'refresh-icon-reasoning', 'refresh-icon-graph'];
  refreshIcons.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const icon = createIcon('RefreshCw', { size: 18, color: 'currentColor', strokeWidth: 2.5 });
      icon.style.display = 'block';
      icon.style.flexShrink = '0';
      el.appendChild(icon);
      
      // Add click animation - find parent button and add spin on click
      const button = el.closest('button');
      if (button) {
        const originalOnClick = button.onclick;
        button.addEventListener('click', (e) => {
          // Spin animation
          icon.style.transition = 'transform 0.6s ease-in-out';
          icon.style.transform = 'rotate(360deg)';
          setTimeout(() => {
            icon.style.transform = 'rotate(0deg)';
          }, 600);
          
          // Call original onclick if it exists
          if (originalOnClick) {
            originalOnClick.call(button, e);
          }
        });
      }
    }
  });
  
  // Menu icon
  const menuIcon = document.getElementById('menu-icon');
  if (menuIcon) {
    const icon = createIcon('Menu', { size: 20, color: 'currentColor' });
    menuIcon.appendChild(icon);
  }
  
  // Plus icon
  const plusIcon = document.getElementById('plus-icon');
  if (plusIcon) {
    const icon = createIcon('Plus', { size: 14, color: 'currentColor' });
    plusIcon.appendChild(icon);
  }
  
  const plusIconMobile = document.getElementById('plus-icon-mobile');
  if (plusIconMobile) {
    const icon = createIcon('Plus', { size: 14, color: 'currentColor' });
    plusIconMobile.appendChild(icon);
  }
  
  // Send icon
  const sendIcon = document.getElementById('send-icon');
  if (sendIcon) {
    const icon = createIcon('Send', { size: 18, color: 'currentColor' });
    sendIcon.appendChild(icon);
  }
  
  // Navigation icons for overview
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
  
  // Mobile navigation icons
  const navIconStatsMobile = document.getElementById('nav-icon-stats-mobile');
  if (navIconStatsMobile) {
    const icon = createIcon('BarChart3', { size: 20, color: '#f97316' });
    navIconStatsMobile.appendChild(icon);
  }
  
  const navIconClusterMobile = document.getElementById('nav-icon-cluster-mobile');
  if (navIconClusterMobile) {
    const icon = createIcon('Server', { size: 20, color: '#f97316' });
    navIconClusterMobile.appendChild(icon);
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
          el.style.transition = '';
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
  
  // Load chat conversations first (default tab)
  loadConversations();
  // Load overview data in background
  loadExecutionStats();
  loadClusterStatus();
  loadSystemHealth();
});

// Auto-refresh every 30 seconds
setInterval(() => {
  const overviewTab = document.getElementById('overview');
  if (overviewTab && overviewTab.classList.contains('active')) {
    loadExecutionStats();
    loadClusterStatus();
    loadSystemHealth();
  }
}, 30000);

