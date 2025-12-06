import { API_URL, escapeHtml } from './utils.js';
import { createConversationItem, createButton } from './components.js';
import { showConfirm } from './modal.js';

// Chat state
let currentEventSource = null;
let currentSessionId = null;
let currentResponseId = null;
let finalEventTimeout = null;
let currentConversationId = null;

// Helper: Get all chat message containers (mobile + desktop)
function getChatMessageContainers() {
  const mobile = document.getElementById('chat-messages');
  const desktop = document.getElementById('chat-messages-desktop');
  return [mobile, desktop].filter(Boolean);
}

// Helper: Get all chat inputs (mobile + desktop)
function getChatInputs() {
  const mobile = document.getElementById('chat-input');
  const desktop = document.getElementById('chat-input-desktop');
  return [mobile, desktop].filter(Boolean);
}

// Helper: Get all send buttons (mobile + desktop)
function getSendButtons() {
  const mobile = document.getElementById('chat-send-btn');
  const desktop = document.getElementById('chat-send-btn-desktop');
  return [mobile, desktop].filter(Boolean);
}

// Helper: Get primary chat messages container (visible one)
function getPrimaryChatMessages() {
  const isMobile = window.innerWidth < 768;
  return document.getElementById(isMobile ? 'chat-messages' : 'chat-messages-desktop');
}

// Helper: Get primary chat input (visible one)
function getPrimaryChatInput() {
  const isMobile = window.innerWidth < 768;
  return document.getElementById(isMobile ? 'chat-input' : 'chat-input-desktop');
}

// Helper: Sync content to all containers
function syncToAllContainers(html) {
  getChatMessageContainers().forEach(container => {
    if (container) container.innerHTML = html;
  });
}

// Export conversation ID getter/setter for other modules
export function getCurrentConversationId() {
  return currentConversationId;
}

export function setCurrentConversationId(id) {
  currentConversationId = id;
}

// Save last active conversation to backend
async function saveLastActiveConversation(conversationId) {
  try {
    const userId = 'dashboard-user';
    await fetch(`${API_URL}/api/user/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        userId,
        lastActiveConversationId: conversationId 
      }),
    });
  } catch (error) {
    console.error('Failed to save last active conversation:', error);
    // Non-critical, don't throw
  }
}

// Restore conversation - prioritize URL, then backend preference
export async function restoreConversation() {
  // First, check URL (for sharing/bookmarking)
  const urlConversationId = getConversationFromUrl();
  if (urlConversationId) {
    currentConversationId = urlConversationId;
    return urlConversationId;
  }
  
  // Fallback to backend preference
  try {
    const userId = 'dashboard-user';
    const response = await fetch(`${API_URL}/api/user/preferences?userId=${userId}`);
    
    if (!response.ok) {
      return null;
    }

    const result = await response.json();
    const conversationId = result.data?.lastActiveConversationId;
    
    if (conversationId) {
      currentConversationId = conversationId;
      // Update URL to match backend preference
      updateConversationUrl(conversationId);
      return conversationId;
    }
  } catch (error) {
    console.error('Failed to restore conversation:', error);
  }
  
  return null;
}

// Helper functions
function formatClusterNodesSection(nodes) {
  if (nodes.length === 0) {
    return '<div style="margin: 12px 0; padding: 12px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #94a3b8;">No nodes discovered in twin.</div>';
  }
  
  let html = '<div style="margin: 12px 0;">';
  for (const node of nodes) {
    const statusColor = node.status === 'online' ? '#10b981' : node.status === 'offline' ? '#ef4444' : '#94a3b8';
    html += `
      <div style="margin-bottom: 8px; padding: 10px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; border-left: 2px solid #f97316;">
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
          <strong style="color: #e2e8f0; font-size: 1.05em;">${escapeHtml(node.name)}</strong>
          <span style="background: ${statusColor}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; font-weight: 600;">${escapeHtml(node.status)}</span>
          <span style="color: #94a3b8; font-size: 0.875em;">${node.vmCount} VM${node.vmCount !== 1 ? 's' : ''}</span>
          <code style="background: #1e293b; padding: 2px 6px; border-radius: 3px; color: #64748b; font-family: 'Courier New', monospace; font-size: 0.8em;">${escapeHtml(node.id)}</code>
        </div>
      </div>
    `;
  }
  html += '</div>';
  return html;
}

function formatClusterVmsSection(vms) {
  if (vms.length === 0) {
    return '<div style="margin: 12px 0; padding: 12px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #94a3b8;">No VMs discovered in twin.</div>';
  }
  
  return '<div style="margin: 12px 0;">' + vms.join('') + '</div>';
}

/**
 * Format clarification messages with clickable options
 */
function formatClarificationMessage(text) {
  const lines = text.split('\n');
  let html = '<div class="clarification-message" style="background: linear-gradient(135deg, #1e3a5f 0%, #1e293b 100%); border: 1px solid #3b82f6; border-radius: 8px; padding: 16px;">';
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Typo detection line
    if (trimmed.startsWith('🔍')) {
      html += `<div style="color: #60a5fa; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.35-4.35"></path>
        </svg>
        <span>${escapeHtml(trimmed.substring(2))}</span>
      </div>`;
      continue;
    }
    
    // "Did you mean" header
    if (trimmed === 'Did you mean one of these?') {
      html += `<div style="color: #e2e8f0; font-weight: 600; margin: 8px 0;">Did you mean one of these?</div>`;
      continue;
    }
    
    // Numbered options - make them clickable
    const optionMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (optionMatch) {
      const [, num, optionText] = optionMatch;
      html += `<button onclick="selectClarificationOption(${num}, '${escapeHtml(optionText).replace(/'/g, "\\'")}')" 
        style="display: block; width: 100%; text-align: left; padding: 10px 12px; margin: 6px 0; 
               background: #0f172a; border: 1px solid #334155; border-radius: 6px; 
               color: #e2e8f0; cursor: pointer; transition: all 0.2s ease;
               font-family: inherit; font-size: 0.95em;"
        onmouseover="this.style.background='#1e293b'; this.style.borderColor='#3b82f6';"
        onmouseout="this.style.background='#0f172a'; this.style.borderColor='#334155';">
        <span style="color: #3b82f6; font-weight: 600; margin-right: 8px;">${num}.</span>
        ${escapeHtml(optionText)}
      </button>`;
      continue;
    }
    
    // Help text
    if (trimmed.startsWith('Reply with')) {
      html += `<div style="color: #64748b; font-size: 0.85em; margin-top: 12px; font-style: italic;">
        ${escapeHtml(trimmed)}
      </div>`;
      continue;
    }
    
    // Unknown entities
    if (trimmed.startsWith('❓')) {
      html += `<div style="color: #f59e0b; margin-top: 8px;">
        ${escapeHtml(trimmed)}
      </div>`;
      continue;
    }
    
    // Empty lines
    if (!trimmed) {
      continue;
    }
    
    // Other text
    html += `<div style="color: #94a3b8; margin: 4px 0;">${escapeHtml(trimmed)}</div>`;
  }
  
  html += '</div>';
  return html;
}

/**
 * Handle clicking a clarification option
 */
window.selectClarificationOption = function(num, optionText) {
  // Send the actual suggestion text (not just the number)
  // This avoids needing server-side state for pending clarifications
  const input = getChatInput();
  if (input) {
    input.value = optionText;
    // Trigger send
    sendChatMessage();
  }
};

function formatAgentResponse(text) {
  if (!text) return '';
  
  // Strip markdown bold (**...**) for cleaner output
  const stripBold = (input) => input.replace(/\*\*(.*?)\*\*/g, '$1');
  text = stripBold(text);
  
  // Check if this is a clarification message
  if (text.includes('🔍') && text.includes('Did you mean')) {
    return formatClarificationMessage(text);
  }
  
  const lines = text.split('\n');
  let html = '';
  let inVmEntry = false;
  let currentVmHtml = '';
  let currentVmName = '';
  
  let inClusterNodes = false;
  let inClusterVms = false;
  let nodeEntries = [];
  let vmList = [];
  let seenVmNames = new Set();
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed.endsWith(':') && !trimmed.startsWith('-')) {
      if (inClusterNodes && nodeEntries.length > 0) {
        html += formatClusterNodesSection(nodeEntries);
        nodeEntries = [];
      }
      if (inClusterVms && vmList.length > 0) {
        html += formatClusterVmsSection(vmList);
        vmList = [];
      }
      
      const sectionName = trimmed.replace(':', '');
      if (sectionName === 'Cluster Nodes') {
        inClusterNodes = true;
        inClusterVms = false;
      } else if (sectionName === 'Cluster VMs' || sectionName.includes('VMs')) {
        inClusterNodes = false;
        inClusterVms = true;
      } else {
        inClusterNodes = false;
        inClusterVms = false;
        html += `<h3 style="margin: 16px 0 8px 0; color: #f97316; font-size: 1.1em; font-weight: 600;">${escapeHtml(sectionName)}</h3>`;
      }
      continue;
    }
    
    if (inClusterNodes && trimmed.startsWith('- ')) {
      const nodeMatch = trimmed.match(/^- (.+?) \(id=(.+?), vms=(\d+), status=(.+?)\)/);
      if (nodeMatch) {
        const [, name, id, vmCount, status] = nodeMatch;
        nodeEntries.push({ name: name.trim(), id: id.trim(), vmCount: parseInt(vmCount), status: status.trim() });
      }
      continue;
    }
    
    if (inClusterVms && trimmed.startsWith('- ') && !trimmed.startsWith('  -')) {
      if (inVmEntry && currentVmHtml && currentVmName) {
        if (!seenVmNames.has(currentVmName)) {
          vmList.push(currentVmHtml + '</div>');
          seenVmNames.add(currentVmName);
        }
        currentVmHtml = '';
        currentVmName = '';
      }
      
      const vmMatch = trimmed.match(/^- (.+?) \((.+?),\s*(.+?)\)/);
      if (vmMatch) {
        const [, name, vmType, state] = vmMatch;
        const vmName = name.trim();
        
        if (seenVmNames.has(vmName)) {
          inVmEntry = false;
          continue;
        }
        
        inVmEntry = true;
        currentVmName = vmName;
        const stateColor = state === 'running' ? '#10b981' : state === 'stopped' ? '#ef4444' : '#94a3b8';
        const typeColor = vmType === 'QEMU VM' ? '#f97316' : '#ea580c';
        currentVmHtml = `
          <div style="margin-bottom: 12px; padding: 12px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; border-left: 2px solid ${typeColor};" data-vm-name="${escapeHtml(vmName)}">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <strong style="color: #e2e8f0; font-size: 1.05em;">${escapeHtml(vmName)}</strong>
              <span style="background: ${typeColor}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; font-weight: 600;">${escapeHtml(vmType.trim())}</span>
              <span style="background: ${stateColor}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; font-weight: 600;">${escapeHtml(state.trim())}</span>
            </div>
        `;
      }
      continue;
    }
    
    if (inClusterVms && trimmed.startsWith('  - ') && !trimmed.startsWith('    -')) {
      const nestedVmMatch = trimmed.match(/^  - (.+?) \((.+?),\s*(.+?)\)/);
      if (nestedVmMatch && inVmEntry && currentVmHtml) {
        const [, name, vmType, state] = nestedVmMatch;
        const stateColor = state === 'running' ? '#10b981' : state === 'stopped' ? '#ef4444' : '#94a3b8';
        const typeColor = vmType === 'QEMU VM' ? '#f97316' : '#ea580c';
        currentVmHtml += `
          <div style="margin-top: 8px; margin-left: 16px; padding: 8px; background: #0a0f1a; border: 1px solid #1e293b; border-radius: 4px; border-left: 2px solid ${typeColor};">
            <div style="display: flex; align-items: center; gap: 8px;">
              <strong style="color: #cbd5e1; font-size: 0.95em;">${escapeHtml(name.trim())}</strong>
              <span style="background: ${typeColor}; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.7em; font-weight: 600;">${escapeHtml(vmType.trim())}</span>
              <span style="background: ${stateColor}; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.7em; font-weight: 600;">${escapeHtml(state.trim())}</span>
            </div>
          </div>
        `;
      }
      continue;
    }
    
    if (inVmEntry && trimmed.startsWith('  - Details:')) {
      const detailsText = trimmed.replace('  - Details:', '').trim();
      const parts = detailsText.split('|').map(p => p.trim());
      let detailsHtml = '<div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid #1e293b;">';
      
      for (const part of parts) {
        if (part.startsWith('trace=')) {
          const traceId = part.replace('trace=', '');
          detailsHtml += `<div style="margin: 4px 0; font-size: 0.875em;">
            <span style="color: #94a3b8;">Trace ID:</span> 
            <code style="background: #1e293b; padding: 2px 6px; border-radius: 3px; color: #f97316; font-family: 'Courier New', monospace; font-size: 0.9em; cursor: pointer;" 
                  onclick="navigator.clipboard.writeText('${escapeHtml(traceId)}'); this.style.background='#f97316'; setTimeout(() => this.style.background='#1e293b', 200);"
                  title="Click to copy">${escapeHtml(traceId)}</code>
          </div>`;
        } else if (part.startsWith('node=')) {
          const nodeName = part.replace('node=', '');
          detailsHtml += `<div style="margin: 4px 0; font-size: 0.875em;">
            <span style="color: #94a3b8;">Node:</span> 
            <span style="color: #e2e8f0; font-weight: 500;">${escapeHtml(nodeName)}</span>
          </div>`;
        } else {
          detailsHtml += `<div style="margin: 4px 0; font-size: 0.875em; color: #94a3b8;">${escapeHtml(part)}</div>`;
        }
      }
      detailsHtml += '</div>';
      currentVmHtml += detailsHtml;
      continue;
    }
    
    if (inVmEntry && trimmed.startsWith('  - Source:')) {
      const sourceText = trimmed.replace('  - Source:', '').trim();
      currentVmHtml += `
        <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid #1e293b; font-size: 0.8em; color: #64748b; font-style: italic;">
          <span style="color: #94a3b8;">Source:</span> ${escapeHtml(sourceText)}
        </div>
      `;
      continue;
    }
    
    if (trimmed.startsWith('Tip:')) {
      html += `<div style="margin-top: 16px; padding: 10px; background: #431407; border-left: 2px solid #f97316; border-radius: 4px; font-size: 0.875em; color: #fed7aa;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 6px; color: #fdba74;">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
        </svg>
        <strong style="color: #93c5fd;">Tip:</strong> ${escapeHtml(trimmed.replace('Tip:', '').trim())}
      </div>`;
      continue;
    }
    
    if (trimmed.startsWith('### ')) {
      if (inVmEntry && currentVmHtml && currentVmName) {
        if (!seenVmNames.has(currentVmName)) {
          vmList.push(currentVmHtml + '</div>');
          seenVmNames.add(currentVmName);
        }
        currentVmHtml = '';
        currentVmName = '';
        inVmEntry = false;
      }
      
      const headerMatch = trimmed.match(/^### Node: (.+?) \(IP: (.+?)\)/);
      if (headerMatch) {
        html += `<h3 style="margin: 16px 0 8px 0; color: #f97316;">${escapeHtml(headerMatch[1])} <span style="color: #94a3b8; font-weight: normal; font-size: 0.85em;">(${escapeHtml(headerMatch[2])})</span></h3>`;
      } else {
        const headerText = trimmed.replace(/^### /, '');
        html += `<h3 style="margin: 16px 0 8px 0; color: #f97316; font-size: 1.1em;">${escapeHtml(headerText)}</h3>`;
      }
      continue;
    }
    
    if (trimmed.startsWith('- ') && !inClusterNodes && !inClusterVms) {
      const listMatch = trimmed.match(/^- \*\*(.+?)\*\*:\s*(.+)$/) || trimmed.match(/^- (.+?):\s*(.+)$/);
      if (listMatch) {
        const label = escapeHtml(listMatch[1]);
        const value = escapeHtml(listMatch[2]);
        html += `<div style="margin: 6px 0; padding-left: 16px;">
          <span style="color: #94a3b8; font-weight: 500;">${label}:</span> 
          <span style="color: #e2e8f0;">${value}</span>
        </div>`;
      } else {
        html += `<div style="margin: 6px 0; padding-left: 16px; color: #e2e8f0;">${escapeHtml(trimmed.replace(/^- /, ''))}</div>`;
      }
      continue;
    }
    
    if (trimmed && !trimmed.startsWith('  -')) {
      if (inVmEntry && currentVmHtml && currentVmName) {
        if (!seenVmNames.has(currentVmName)) {
          vmList.push(currentVmHtml + '</div>');
          seenVmNames.add(currentVmName);
        }
        currentVmHtml = '';
        currentVmName = '';
        inVmEntry = false;
      }
      
      let processedLine = escapeHtml(trimmed);
      processedLine = processedLine.replace(/\*\*(.+?)\*\*/g, '<strong style="color: #e2e8f0; font-weight: 600;">$1</strong>');
      html += `<p style="margin: 8px 0; color: #cbd5e1; line-height: 1.5;">${processedLine}</p>`;
    } else if (!trimmed && !inVmEntry) {
      html += '<br>';
    }
  }
  
  if (inClusterNodes && nodeEntries.length > 0) {
    html += formatClusterNodesSection(nodeEntries);
  }
  if (inClusterVms) {
    if (inVmEntry && currentVmHtml && currentVmName) {
      if (!seenVmNames.has(currentVmName)) {
        vmList.push(currentVmHtml + '</div>');
        seenVmNames.add(currentVmName);
      }
    }
    if (vmList.length > 0) {
      html += formatClusterVmsSection(vmList);
    }
  }
  
  return html;
}

function updateChatMessage(messageId, newContent) {
  // Update in all containers (mobile + desktop)
  getChatMessageContainers().forEach(messagesDiv => {
    if (!messagesDiv) return;
    const messageDiv = messagesDiv.querySelector(`#${messageId}`);
    if (messageDiv) {
      const wasNearBottom = messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < 100;
      messageDiv.innerHTML = newContent;
      if (wasNearBottom) {
        requestAnimationFrame(() => {
          messagesDiv.scrollTop = messagesDiv.scrollHeight;
        });
      }
    }
  });
}

function addChatMessage(role, content, isLoading = false, messageId = null, dbId = null, reasoningTraceId = null) {
  const containers = getChatMessageContainers();
  const msgId = messageId || 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  
  // Remove welcome message from all containers
  containers.forEach(c => {
    const welcomeMsg = c.querySelector('div[style*="text-align: center"]');
    if (welcomeMsg) welcomeMsg.remove();
  });

  const messageDiv = document.createElement('div');
  messageDiv.id = msgId;
  messageDiv.dataset.dbId = dbId || '';
  
  // iOS-like styling with solid backgrounds and visual artifacts
  const isUser = role === 'user';
  messageDiv.style.cssText = `
    margin-bottom: 8px;
    padding: 12px 16px;
    border-radius: ${isUser ? '18px 18px 4px 18px' : '18px 18px 18px 4px'};
    max-width: 75%;
    word-wrap: break-word;
    position: relative;
    ${isUser 
      ? `
        background: linear-gradient(135deg, #7c2d12 0%, #9a3412 50%, #7c2d12 100%);
        background-size: 200% 200%;
        margin-left: auto;
        margin-right: 0;
        color: #fef3e7;
        box-shadow: 0 2px 8px rgba(124, 45, 18, 0.4), 0 1px 3px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(249, 115, 22, 0.3);
      ` 
      : `
        background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
        margin-left: 0;
        margin-right: auto;
        color: #e2e8f0;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(51, 65, 85, 0.5);
      `}
  `;
  
  // Add subtle texture overlay for depth
  if (!isUser) {
    messageDiv.style.backgroundImage = `
      linear-gradient(135deg, #1e293b 0%, #0f172a 100%),
      repeating-linear-gradient(
        45deg,
        transparent,
        transparent 2px,
        rgba(51, 65, 85, 0.03) 2px,
        rgba(51, 65, 85, 0.03) 4px
      )
    `;
  }

  const traceLink = (role === 'assistant' && reasoningTraceId) ? `
    <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #334155; display: flex; align-items: center; gap: 8px; font-size: 0.75em;">
      <button
        onclick="navigator.clipboard.writeText('${reasoningTraceId}'); this.style.background='#f97316'; setTimeout(() => this.style.background='#1e293b', 200);"
        style="
          background: #1e293b;
          border: 1px solid #334155;
          color: #94a3b8;
          padding: 4px 8px;
          border-radius: 4px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 0.9em;
        "
        title="Copy trace ID"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
        </svg>
        Trace: ${reasoningTraceId.substring(0, 8)}...
      </button>
      <button
        onclick="window.switchTab('reasoning', null); setTimeout(() => { const traces = document.getElementById('reasoning-traces'); if (traces) traces.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 300);"
        style="
          background: #7c2d12;
          border: 1px solid #f97316;
          color: #e2e8f0;
          padding: 4px 8px;
          border-radius: 4px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 0.9em;
        "
        title="View reasoning trace"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
        </svg>
        View Trace
      </button>
    </div>
  ` : '';

  if (role === 'user') {
    messageDiv.innerHTML = `
      <div style="white-space: pre-wrap; line-height: 1.4; font-size: 15px;">${escapeHtml(content)}</div>
    `;
  } else {
    messageDiv.innerHTML = `
      <div style="line-height: 1.5; font-size: 15px;">
        ${isLoading 
          ? `<div style="color: #94a3b8; font-style: italic;">${content}</div>`
          : content}
        ${traceLink}
      </div>
    `;
  }

  // Append to all containers
  containers.forEach(messagesDiv => {
    const clone = messageDiv.cloneNode(true);
    const wasNearBottom = messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < 100;
    messagesDiv.appendChild(clone);
    if (wasNearBottom || isLoading || role === 'user') {
      requestAnimationFrame(() => {
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
      });
    }
  });

  return msgId;
}

function removeChatMessage(messageId) {
  // Remove from all containers
  getChatMessageContainers().forEach(container => {
    const message = container.querySelector(`#${messageId}`);
    if (message) message.remove();
    if (container.children.length === 0) {
      container.innerHTML = '<div style="color: #94a3b8; text-align: center; padding: 20px; font-size: 0.875rem;">Start a conversation with Palindrome.</div>';
    }
  });
}

function handleAgentEvent(event, toolExecutions) {
  const messagesDiv = getPrimaryChatMessages();
  
  switch (event.type) {
    case 'agent:step':
      updateChatMessage(currentResponseId, 
        `<div class="agent-thinking">
          <svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
          Reasoning step ${event.data.step}/${event.data.maxSteps}...
        </div>`);
      break;
      
    case 'tool:start':
      const toolInfo = {
        toolName: event.data.toolName,
        params: event.data.parameters,
        startTime: Date.now()
      };
      toolExecutions.push(toolInfo);
      
      const paramsStr = Object.entries(event.data.parameters || {})
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v.substring(0, 30) : JSON.stringify(v).substring(0, 30)}`)
        .join(', ');
      
      const toolHtml = `
        <div data-tool-name="${escapeHtml(event.data.toolName)}" style="margin-top: 8px; padding: 8px 10px; background: #1e3a8a; border-radius: 4px; font-size: 0.85em;">
          <svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="color: #f97316;"><path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>
          <strong style="color: #e2e8f0;">${escapeHtml(event.data.toolName)}</strong>
          ${paramsStr ? `<div style="color: #94a3b8; margin-top: 4px; font-size: 0.9em;">${escapeHtml(paramsStr)}</div>` : ''}
          <div style="color: #94a3b8; margin-top: 4px; font-size: 0.9em;">
            <svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
            Executing...
          </div>
        </div>
      `;
      
      const toolMessageDiv = document.getElementById(currentResponseId);
      if (toolMessageDiv) {
        const currentContent = toolMessageDiv.innerHTML;
        toolMessageDiv.innerHTML = currentContent + toolHtml;
      } else {
        updateChatMessage(currentResponseId, 
          `<div class="agent-thinking">
            <svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
            Thinking...
          </div>${toolHtml}`);
      }
      break;
      
    case 'tool:progress':
      // Update existing tool card with progress info
      const progressMessageDiv = document.getElementById(currentResponseId);
      if (progressMessageDiv) {
        const toolDivs = progressMessageDiv.querySelectorAll('div[data-tool-name]');
        const progressToolDiv = Array.from(toolDivs).find(d => 
          d.getAttribute('data-tool-name') === event.data.toolName
        );
        
        if (progressToolDiv) {
          const progress = event.data.progress || 0;
          const progressPercent = Math.round(progress * 100);
          const statusColor = event.data.status === 'failed' ? '#ef4444' 
            : event.data.status === 'completed' ? '#10b981' 
            : event.data.status === 'waiting' ? '#f59e0b' 
            : '#3b82f6';
          
          const statusIcon = event.data.status === 'failed' 
            ? '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="color: #ef4444;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
            : event.data.status === 'completed'
            ? '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="color: #10b981;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
            : event.data.status === 'waiting'
            ? '<svg class="icon spin" viewBox="0 0 24 24" fill="currentColor" style="color: #f59e0b;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>'
            : '<svg class="icon spin" viewBox="0 0 24 24" fill="currentColor" style="color: #3b82f6;"><path d="M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8c-.45-.83-.7-1.79-.7-2.8 0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z"/></svg>';
          
          const actionLabel = event.data.action ? `<span style="color: #94a3b8; font-weight: normal;">(${event.data.action})</span>` : '';
          
          progressToolDiv.innerHTML = `
            ${statusIcon}
            <strong style="color: #e2e8f0;">${escapeHtml(event.data.toolName)}</strong>
            ${actionLabel}
            <div style="color: ${statusColor}; margin-top: 6px; font-size: 0.9em;">
              ${escapeHtml(event.data.message)}
            </div>
            ${progress > 0 && progress < 1 ? `
              <div style="margin-top: 6px; height: 4px; background: #334155; border-radius: 2px; overflow: hidden;">
                <div style="height: 100%; width: ${progressPercent}%; background: ${statusColor}; transition: width 0.3s ease;"></div>
              </div>
              <div style="color: #64748b; font-size: 0.75em; margin-top: 2px;">${progressPercent}%</div>
            ` : ''}
          `;
        }
      }
      break;
      
    case 'tool:complete':
      const tool = toolExecutions.find(t => t.toolName === event.data.toolName);
      const duration = event.data.durationMs || (tool ? Date.now() - tool.startTime : 0);
      const statusColor = event.data.success ? '#10b981' : '#ef4444';
      
      const completeMessageDiv = document.getElementById(currentResponseId);
      if (completeMessageDiv) {
        const toolDivs = completeMessageDiv.querySelectorAll('div[data-tool-name]');
        const toolDiv = Array.from(toolDivs).find(d => 
          d.getAttribute('data-tool-name') === event.data.toolName
        );
        
        if (toolDiv) {
          const successIcon = event.data.success 
            ? '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="color: #10b981;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
            : '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="color: #ef4444;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
          toolDiv.innerHTML = `
            ${successIcon}
            <strong style="color: #e2e8f0;">${escapeHtml(event.data.toolName)}</strong>
            <span style="color: ${statusColor}; margin-left: 8px; font-size: 0.9em;">${event.data.success ? 'Completed' : 'Failed'}</span>
            <div style="color: #94a3b8; margin-top: 4px; font-size: 0.85em;">
              <svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
              ${duration}ms
            </div>
            ${event.data.error ? `<div style="color: #ef4444; margin-top: 4px; font-size: 0.85em;">${escapeHtml(event.data.error)}</div>` : ''}
          `;
        }
      }
      break;
      
    case 'agent:final':
      const formattedText = formatAgentResponse(event.data.text || 'No response');
      const durationSeconds = (event.data.durationMs || 0) / 1000;
      const traceId = event.data.traceId;
      
      setTimeout(() => {
        if (currentConversationId) {
          loadChatHistory(currentConversationId);
        }
        // Refresh conversation list to update message counts
        loadConversations();
      }, 500);
      
      const traceLinkHtml = traceId ? `
        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(51, 65, 85, 0.5); display: flex; align-items: center; gap: 8px; font-size: 0.8em;">
          <button
            onclick="navigator.clipboard.writeText('${traceId}'); this.style.background='#f97316'; setTimeout(() => this.style.background='rgba(30, 41, 59, 0.6)', 200);"
            style="
              background: rgba(30, 41, 59, 0.6);
              border: 1px solid rgba(51, 65, 85, 0.5);
              color: #94a3b8;
              padding: 6px 10px;
              border-radius: 12px;
              cursor: pointer;
              display: flex;
              align-items: center;
              gap: 4px;
              font-size: 0.85em;
              transition: all 0.2s;
            "
            onmouseover="this.style.background='rgba(30, 41, 59, 0.8)'"
            onmouseout="this.style.background='rgba(30, 41, 59, 0.6)'"
            title="Copy trace ID"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
            </svg>
            Trace: ${traceId.substring(0, 8)}...
          </button>
          <button
            onclick="window.switchTab('reasoning', null); setTimeout(() => { const traces = document.getElementById('reasoning-traces'); if (traces) traces.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 300);"
            style="
              background: rgba(124, 45, 18, 0.6);
              border: 1px solid rgba(249, 115, 22, 0.5);
              color: #e2e8f0;
              padding: 6px 10px;
              border-radius: 12px;
              cursor: pointer;
              display: flex;
              align-items: center;
              gap: 4px;
              font-size: 0.85em;
              transition: all 0.2s;
            "
            onmouseover="this.style.background='rgba(124, 45, 18, 0.8)'"
            onmouseout="this.style.background='rgba(124, 45, 18, 0.6)'"
            title="View reasoning trace"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
            </svg>
            View Trace
          </button>
        </div>
      ` : '';
      
      const finalHtml = `
        <div class="agent-response" style="line-height: 1.6;">
          ${formattedText}
        </div>
        ${toolExecutions.length > 0 ? `
          <div style="margin-top: 16px; padding: 10px; background: #0f172a; border-top: 1px solid #334155; border-radius: 0 0 6px 6px; color: #94a3b8; font-size: 0.85em; display: flex; align-items: center; gap: 12px;">
            <svg style="width: 16px; height: 16px; opacity: 0.7;" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
            <span>Executed ${toolExecutions.length} tool${toolExecutions.length !== 1 ? 's' : ''} in ${durationSeconds.toFixed(2)}s</span>
          </div>
        ` : ''}
        ${traceLinkHtml}
      `;
      
      updateChatMessage(currentResponseId, finalHtml);
      // Scroll is handled inside updateChatMessage
      
      if (currentEventSource) {
        currentEventSource.close();
        currentEventSource = null;
      }
      
      if (finalEventTimeout) {
        clearTimeout(finalEventTimeout);
        finalEventTimeout = null;
      }
      
      getChatInputs().forEach(i => i.disabled = false);
      getSendButtons().forEach(b => b.disabled = false);
      const primaryInput = getPrimaryChatInput();
      if (primaryInput) setTimeout(() => primaryInput.focus(), 100);
      break;
  }
}

// Main chat functions
export async function sendChatMessage() {
  const inputs = getChatInputs();
  const buttons = getSendButtons();
  const primaryInput = getPrimaryChatInput();
  
  const message = primaryInput?.value?.trim() || '';
  if (!message) return;

  inputs.forEach(i => { i.disabled = true; i.value = ''; });
  buttons.forEach(b => b.disabled = true);

  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }

  addChatMessage('user', message);

  currentResponseId = addChatMessage('assistant', `
    <div class="agent-thinking">
      <svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
      Thinking...
    </div>
  `, true);

  try {
    if (!currentConversationId) {
      try {
        const createResponse = await fetch(`${API_URL}/api/chat/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: 'dashboard-user' }),
        });
        if (createResponse.ok) {
          const createResult = await createResponse.json();
          currentConversationId = createResult.data.id;
          setCurrentConversationId(currentConversationId);
          await saveLastActiveConversation(currentConversationId); // Save to backend
          await loadConversations();
        }
      } catch (error) {
        console.error('Failed to create conversation:', error);
      }
    }

    const startResponse = await fetch(`${API_URL}/api/agent/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        query: message, 
        userId: 'dashboard-user', 
        aclGroup: 'admin',
        conversationId: currentConversationId
      })
    });

    if (!startResponse.ok) {
      throw new Error(`HTTP ${startResponse.status}: ${startResponse.statusText}`);
    }

    const startResult = await startResponse.json();
    currentSessionId = startResult.sessionId;
    
    if (startResult.conversationId && !currentConversationId) {
      currentConversationId = startResult.conversationId;
      setCurrentConversationId(currentConversationId);
      await saveLastActiveConversation(currentConversationId); // Save to backend
      await loadConversations();
    } else if (currentConversationId) {
      // Refresh conversation list to update message count even if conversation already exists
      await saveLastActiveConversation(currentConversationId); // Update last active
      loadConversations();
    }

    currentEventSource = new EventSource(`${API_URL}/api/agent/stream?sessionId=${currentSessionId}`);
    
    let toolExecutions = [];
    let finalText = '';
    const currentQuery = message;

    currentEventSource.onmessage = (event) => {
      try {
        const agentEvent = JSON.parse(event.data);
        handleAgentEvent(agentEvent, toolExecutions);
        
        if (agentEvent.type === 'agent:final') {
          finalText = agentEvent.data.text || '';
        }
      } catch (error) {
        console.error('Error parsing SSE event:', error);
      }
    };

    currentEventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
      
      if (finalEventTimeout) {
        clearTimeout(finalEventTimeout);
        finalEventTimeout = null;
      }
      
      if (currentEventSource.readyState === EventSource.CLOSED) {
        if (finalText) {
          updateChatMessage(currentResponseId, `
            <div class="agent-response" style="line-height: 1.6;">
              ${formatAgentResponse(finalText)}
            </div>
            ${toolExecutions.length > 0 ? `
              <div style="margin-top: 16px; padding: 10px; background: #0f172a; border-top: 1px solid #334155; border-radius: 0 0 6px 6px; color: #94a3b8; font-size: 0.85em;">
                Executed ${toolExecutions.length} tool${toolExecutions.length !== 1 ? 's' : ''}
              </div>
            ` : ''}
          `);
        } else {
          updateChatMessage(currentResponseId, `
            <div style="color: #fbbf24; padding: 12px; background: #78350f; border-radius: 6px; border-left: 2px solid #fbbf24; margin-top: 10px;">
              <strong>⚠️ Connection closed</strong><br>
              <span style="font-size: 0.9em;">The agent may still be processing. Try refreshing or asking again.</span>
            </div>
          `);
        }
        
        input.disabled = false;
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        input.focus();
      }
      
      currentEventSource.close();
      currentEventSource = null;
    };

    finalEventTimeout = setTimeout(() => {
      if (currentEventSource && finalText) {
        updateChatMessage(currentResponseId, `
          <div class="agent-response" style="line-height: 1.6;">
            ${formatAgentResponse(finalText)}
          </div>
          ${toolExecutions.length > 0 ? `
            <div style="margin-top: 16px; padding: 10px; background: #0f172a; border-top: 1px solid #334155; border-radius: 0 0 6px 6px; color: #94a3b8; font-size: 0.85em;">
              Executed ${toolExecutions.length} tool${toolExecutions.length !== 1 ? 's' : ''}
            </div>
          ` : ''}
        `);
        
        currentEventSource.close();
        currentEventSource = null;
        
        input.disabled = false;
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        input.focus();
      } else if (currentEventSource && !finalText) {
        const isActionOperation = currentQuery && (
          currentQuery.toLowerCase().includes('create') ||
          currentQuery.toLowerCase().includes('destroy') ||
          currentQuery.toLowerCase().includes('provision') ||
          currentQuery.toLowerCase().includes('start') ||
          currentQuery.toLowerCase().includes('stop') ||
          currentQuery.toLowerCase().includes('vm') ||
          currentQuery.toLowerCase().includes('container')
        );
        // Default 120s timeout, 5 min for actions
        const timeoutMs = isActionOperation ? 300000 : 120000;
        
        updateChatMessage(currentResponseId, `
          <div style="color: #fbbf24; padding: 12px; background: #78350f; border-radius: 6px; border-left: 2px solid #fbbf24;">
            <strong>⚠️ Response timeout</strong><br>
            <span style="font-size: 0.9em;">The agent is taking longer than expected (${timeoutMs / 1000}s timeout). The operation may still be running. Check the reasoning traces tab for details.</span>
          </div>
        `);
        
        currentEventSource.close();
        currentEventSource = null;
        
        input.disabled = false;
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
        input.focus();
      }
      finalEventTimeout = null;
    }, (() => {
      const isActionOperation = message && (
        message.toLowerCase().includes('create') ||
        message.toLowerCase().includes('destroy') ||
        message.toLowerCase().includes('provision') ||
        message.toLowerCase().includes('start') ||
        message.toLowerCase().includes('stop') ||
        message.toLowerCase().includes('vm') ||
        message.toLowerCase().includes('container')
      );
      // Default 120s timeout, 5 min for actions  
      return isActionOperation ? 300000 : 120000;
    })());

  } catch (error) {
    if (currentResponseId) {
      removeChatMessage(currentResponseId);
    }
    
    addChatMessage('assistant', `<div style="color: #ef4444;">Error: ${escapeHtml(error.message)}</div>`);
    
    input.disabled = false;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    input.focus();
  }
}

export async function loadConversations() {
  const listDiv = document.getElementById('conversation-list');
  const listDivMobile = document.getElementById('conversation-list-mobile');
  if (!listDiv && !listDivMobile) return;

  try {
    const userId = 'dashboard-user';
    const response = await fetch(`${API_URL}/api/chat/conversations?userId=${userId}`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    const conversations = result.data || [];

    const emptyMessage = '<div class="text-slate-400 text-center py-5 text-sm">No conversations yet. Create a new one to start!</div>';
    
    if (conversations.length === 0) {
      if (listDiv) listDiv.innerHTML = emptyMessage;
      if (listDivMobile) listDivMobile.innerHTML = emptyMessage;
      return;
    }

    const renderList = (container) => {
      if (!container) return;
      container.innerHTML = '';
      conversations.forEach(conv => {
        const item = createConversationItem(
          {
            id: conv.id,
            title: conv.title,
            messageCount: conv.messageCount
          },
          {
            isActive: currentConversationId === conv.id,
            onSelect: (id) => window.selectConversation(id),
            onDelete: (id) => window.deleteConversation(id)
          }
        );
        container.appendChild(item);
      });

      if (currentConversationId) {
        const currentItem = container.querySelector(`[data-conversation-id="${currentConversationId}"]`);
        if (currentItem) {
          currentItem.scrollIntoView({ block: 'nearest' });
        }
      }
    };

    renderList(listDiv);
    renderList(listDivMobile);
  } catch (error) {
    console.error('Failed to load conversations:', error);
    const errorMessage = '<div class="text-red-400 text-center py-5 text-sm">Failed to load conversations</div>';
    if (listDiv) listDiv.innerHTML = errorMessage;
    if (listDivMobile) listDivMobile.innerHTML = errorMessage;
  }
}

export async function selectConversation(conversationId) {
  currentConversationId = conversationId;
  setCurrentConversationId(conversationId);
  await saveLastActiveConversation(conversationId); // Save to backend
  
  // Update URL for sharing/bookmarking
  updateConversationUrl(conversationId);
  
  await loadChatHistory(conversationId);
  loadConversations();
}

// Update URL with conversation ID (for sharing/bookmarking)
function updateConversationUrl(conversationId) {
  const url = new URL(window.location.href);
  if (conversationId) {
    url.searchParams.set('conversation', conversationId);
  } else {
    url.searchParams.delete('conversation');
  }
  // Use replaceState to avoid cluttering browser history
  window.history.replaceState({ conversationId }, '', url.toString());
}

// Get conversation ID from URL
function getConversationFromUrl() {
  const url = new URL(window.location.href);
  return url.searchParams.get('conversation');
}

export async function createNewConversation() {
  try {
    const userId = 'dashboard-user';
    const response = await fetch(`${API_URL}/api/chat/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    const newConversationId = result.data.id;

    await selectConversation(newConversationId);
  } catch (error) {
    console.error('Failed to create conversation:', error);
    alert('Failed to create conversation: ' + error.message);
  }
}

export async function deleteConversation(conversationId) {
  showConfirm({
    title: 'Delete Conversation',
    message: 'Delete this conversation? All messages will be permanently deleted.',
    confirmText: 'Delete',
    cancelText: 'Cancel',
    onConfirm: async () => {
      try {
    const userId = 'dashboard-user';
    const response = await fetch(`${API_URL}/api/chat/conversations/${conversationId}?userId=${userId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    if (currentConversationId === conversationId) {
      currentConversationId = null;
      setCurrentConversationId(null);
      await saveLastActiveConversation(null); // Clear from backend
      updateConversationUrl(null); // Clear from URL
      const messagesDiv = document.getElementById('chat-messages');
      if (messagesDiv) {
        messagesDiv.innerHTML = '<div style="color: #94a3b8; text-align: center; padding: 20px;">Select a conversation or create a new one to start chatting.</div>';
      }
    }

        await loadConversations();
      } catch (error) {
        console.error('Failed to delete conversation:', error);
        alert('Failed to delete conversation: ' + error.message);
      }
    },
    onCancel: () => {
      // User cancelled, do nothing
    }
  });
}

export async function loadChatHistory(conversationId = null) {
  const containers = getChatMessageContainers();
  if (containers.length === 0) return;

  if (!conversationId) {
    syncToAllContainers('<div style="color: #94a3b8; text-align: center; padding: 20px; font-size: 0.875rem;">Select a conversation or create a new one.</div>');
    return;
  }

  try {
    const userId = 'dashboard-user';
    const response = await fetch(`${API_URL}/api/chat/conversations/${conversationId}/messages?userId=${userId}&limit=100`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    const messages = result.data || [];

    // Clear all containers
    containers.forEach(c => c.innerHTML = '');

    if (messages.length === 0) {
      syncToAllContainers('<div style="color: #94a3b8; text-align: center; padding: 20px; font-size: 0.875rem;">Start a conversation with Palindrome.</div>');
      return;
    }

    messages.forEach(msg => {
      if (msg.role === 'user') {
        addChatMessage('user', msg.content, false, null, msg.id, null);
      } else {
        const formattedContent = formatAgentResponse(msg.content);
        addChatMessage('assistant', formattedContent, false, null, msg.id, msg.reasoningTraceId || null);
      }
    });

    // Scroll to bottom in all containers
    containers.forEach(c => {
      requestAnimationFrame(() => {
        c.scrollTop = c.scrollHeight;
      });
    });
  } catch (error) {
    console.error('Failed to load chat history:', error);
    syncToAllContainers('<div style="color: #ef4444; text-align: center; padding: 20px; font-size: 0.875rem;">Failed to load messages</div>');
  }
}

export async function deleteChatMessage(dbId, messageId) {
  showConfirm({
    title: 'Delete Message',
    message: 'Delete this message?',
    confirmText: 'Delete',
    cancelText: 'Cancel',
    onConfirm: async () => {
      try {
        const userId = 'dashboard-user';
        const response = await fetch(`${API_URL}/api/chat/history/${dbId}?userId=${userId}`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        removeChatMessage(messageId);
      } catch (error) {
        console.error('Failed to delete message:', error);
        alert('Failed to delete message: ' + error.message);
      }
    },
    onCancel: () => {
      // User cancelled, do nothing
    }
  });
}

// Make functions globally accessible for onclick handlers
window.sendChatMessage = sendChatMessage;
window.selectConversation = selectConversation;
window.createNewConversation = createNewConversation;
window.deleteConversation = deleteConversation;
window.deleteChatMessage = deleteChatMessage;
