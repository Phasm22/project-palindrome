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

// Make switchTab globally accessible
window.switchTab = function(tabName, clickedElement) {
  // Hide all tabs
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  
  // Show selected tab
  if (clickedElement) {
    clickedElement.classList.add('active');
  } else {
    // Fallback: find tab by text content
    document.querySelectorAll('.tab').forEach(t => {
      if (t.textContent.trim().toLowerCase().includes(tabName.toLowerCase())) {
        t.classList.add('active');
      }
    });
  }
  document.getElementById(tabName).classList.add('active');
  
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
  }
};

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

