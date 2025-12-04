import { loadConversations, sendChatMessage, selectConversation, createNewConversation, deleteConversation, deleteChatMessage } from './chat.js';
import { loadToolExecutions } from './executions.js';
import { loadReasoningTraces } from './reasoning.js';
import { loadGraph } from './graph.js';
import { setupQueryInterface, executeQuery, executeGraphQuery, executeCypherQuery } from './query.js';
import { loadExecutionStats, loadClusterStatus, loadSystemHealth } from './overview.js';
import { testRagQuery } from './rag.js';

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

// Make switchTab globally accessible immediately
(function() {
  window.switchTab = function(tabName, clickedElement) {
  // Hide all tabs
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.remove('active', 'text-primary-500', 'border-primary-500');
    t.classList.add('text-slate-400', 'border-transparent');
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.add('hidden');
    c.classList.remove('flex', 'flex-col');
  });
  
  // Show selected tab
  if (clickedElement) {
    clickedElement.classList.remove('text-slate-400', 'border-transparent');
    clickedElement.classList.add('active', 'text-primary-500', 'border-primary-500');
  } else {
    // Fallback: find tab by text content
    document.querySelectorAll('.tab').forEach(t => {
      if (t.textContent.trim().toLowerCase().includes(tabName.toLowerCase())) {
        t.classList.remove('text-slate-400', 'border-transparent');
        t.classList.add('active', 'text-primary-500', 'border-primary-500');
      }
    });
  }
  const tabContent = document.getElementById(tabName);
  if (tabContent) {
    tabContent.classList.remove('hidden');
    tabContent.classList.add('flex', 'flex-col');
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
    // Focus chat input when switching to chat tab
    setTimeout(() => {
      const chatInput = document.getElementById('chat-input');
      if (chatInput) chatInput.focus();
    }, 100);
  }
  
  // Show/hide floating nav for overview tab
  const overviewNav = document.getElementById('overview-nav');
  if (overviewNav) {
    overviewNav.style.display = tabName === 'overview' ? 'flex' : 'none';
  };
})();

// Load initial data when page loads
window.addEventListener('DOMContentLoaded', () => {
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

