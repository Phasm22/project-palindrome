import { API_URL, escapeHtml } from './utils.js';
import { createButton } from './components.js';
import { showConfirm } from './modal.js';

// Chat state
let currentEventSource = null;
let currentSessionId = null;
let currentResponseId = null;
let finalEventTimeout = null;
let currentConversationId = null;
let isNewConversationMode = false; // True when user clicked "New" but hasn't sent a message yet
let isCreatingConversation = false; // Prevent spamming New Chat button
let promptSuggestionCache = null;
let promptSuggestionCacheAt = 0;
const PROMPT_SUGGESTIONS_TTL_MS = 5 * 60 * 1000;
const FALLBACK_PROMPT_SUGGESTIONS = [
  { title: "Cluster overview", prompt: "Describe the cluster status and VM counts." },
  { title: "Node temperatures", prompt: "Show temperature readings for all nodes." },
  { title: "Running VMs", prompt: "List all running VMs." },
  { title: "Firewall rules", prompt: "Show firewall rules affecting the cluster." },
];

// Scroll lock state - track async operations and user scroll behavior
let isAsyncOperationActive = false;
let shouldAutoScroll = true; // Whether to auto-scroll to bottom
let scrollLockTimeout = null;
let scrollHandlersAttached = false;
let scrollScheduled = false; // Prevent multiple scroll operations
let scrollToBottomBtn = null; // Scroll to bottom button reference
let scrollContainerRef = null; // Current scroll container reference

/**
 * Global scroll handler - detects when user scrolls up during async operations
 */
function handleScrollDuringAsync(e) {
  const target = e?.target instanceof HTMLElement ? e.target : null;
  const scrollContainer = getChatScrollContainer(target);
  if (!scrollContainer) return;

  if (isAsyncOperationActive) {
    const { distanceFromBottom } = getScrollMetrics(scrollContainer);
    // If user scrolled up more than 150px from bottom, disable auto-scroll
    if (distanceFromBottom > 150) {
      shouldAutoScroll = false;
    }
  }

  // Always update scroll-to-bottom button visibility
  updateScrollToBottomButton(scrollContainer);
}

/**
 * Update scroll-to-bottom button visibility based on scroll position
 */
function updateScrollToBottomButton(preferredContainer) {
  if (!scrollToBottomBtn) {
    scrollToBottomBtn = document.getElementById('scroll-to-bottom-btn');
  }
  if (!scrollToBottomBtn) return;

  const scrollContainer = getChatScrollContainer(preferredContainer);
  if (!scrollContainer) return;

  const { distanceFromBottom, clientHeight } = getScrollMetrics(scrollContainer);
  // Show button when more than 1 viewport height from bottom (or 200px minimum)
  const threshold = Math.max(clientHeight, 200);

  if (distanceFromBottom > threshold) {
    scrollToBottomBtn.classList.remove('hidden');
  } else {
    scrollToBottomBtn.classList.add('hidden');
  }
}

/**
 * Scroll chat to bottom (called by button)
 */
window.scrollChatToBottom = function() {
  const scrollContainer = getChatScrollContainer();
  scrollToBottom(scrollContainer, 'smooth');
  
  shouldAutoScroll = true;
  
  // Hide button after scrolling
  if (scrollToBottomBtn) {
    setTimeout(() => {
      if (scrollToBottomBtn) {
        scrollToBottomBtn.classList.add('hidden');
      }
    }, 500);
  }
};

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

// Helper: Get the active scroll container for chat
function getChatScrollContainer(preferred = null) {
  if (preferred && preferred instanceof HTMLElement) {
    return preferred;
  }
  const isMobile = window.innerWidth < 768;
  if (isMobile) {
    return document.getElementById('chat-messages');
  }
  return document.getElementById('chat-messages-desktop');
}

// Helper: Get scroll metrics for a container
function getScrollMetrics(container) {
  if (!container) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0, distanceFromBottom: 0 };
  const scrollTop = container.scrollTop;
  const scrollHeight = container.scrollHeight;
  const clientHeight = container.clientHeight;
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    distanceFromBottom: scrollHeight - (scrollTop + clientHeight),
  };
}

// Helper: Scroll a container to bottom
function scrollToBottom(container, behavior = 'auto') {
  if (!container) return;
  container.scrollTo({ top: container.scrollHeight, behavior });
}

// Helper: Sync content to all containers
function syncToAllContainers(html) {
  getChatMessageContainers().forEach(container => {
    if (container) container.innerHTML = html;
  });
}

async function fetchPromptSuggestions() {
  const now = Date.now();
  if (promptSuggestionCache && (now - promptSuggestionCacheAt) < PROMPT_SUGGESTIONS_TTL_MS) {
    return promptSuggestionCache;
  }

  try {
    const response = await fetch(`${API_URL}/api/dashboard/prompt-suggestions`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const result = await response.json();
    const suggestions = result?.data?.suggestions;
    if (Array.isArray(suggestions) && suggestions.length > 0) {
      promptSuggestionCache = suggestions;
      promptSuggestionCacheAt = now;
      return suggestions;
    }
  } catch (error) {
    console.warn("Failed to fetch prompt suggestions, using defaults.", error);
  }

  return FALLBACK_PROMPT_SUGGESTIONS;
}

function attachPromptSuggestionHandlers(container) {
  const buttons = container.querySelectorAll("[data-suggestion-prompt]");
  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      const encoded = btn.getAttribute("data-suggestion-prompt") || "";
      const prompt = decodeURIComponent(encoded);
      if (prompt) {
        sendChatMessage(prompt);
      }
    });
  });
}

async function renderPreChatSuggestions() {
  if (!isNewConversationMode) return;
  const containers = getChatMessageContainers();
  if (containers.length === 0) return;

  const suggestions = await fetchPromptSuggestions();
  const tilesHtml = suggestions.map((suggestion) => {
    const title = escapeHtml(suggestion.title || "Suggested prompt");
    const prompt = suggestion.prompt || "";
    const promptEscaped = escapeHtml(prompt);
    const promptEncoded = encodeURIComponent(prompt);
    return `
      <button
        class="group w-full text-left border border-slate-700/50 bg-slate-900/60 hover:bg-slate-900/80 rounded-lg p-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        data-suggestion-prompt="${promptEncoded}"
        aria-label="Send prompt: ${promptEscaped}"
        type="button"
      >
        <div class="text-slate-200 text-sm font-semibold mb-1">${title}</div>
        <div class="text-slate-400 text-xs leading-relaxed">${promptEscaped}</div>
      </button>
    `;
  }).join("");

  const html = `
    <div class="w-full max-w-5xl mx-auto px-4 py-4" data-pre-chat-suggestions="true">
      <div class="text-slate-400 text-center text-sm mb-4">Suggested prompts</div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        ${tilesHtml || '<div class="text-slate-500 text-center text-sm">No suggestions available yet.</div>'}
      </div>
    </div>
  `;

  containers.forEach(c => {
    if (c) {
      c.innerHTML = html;
      c.style.display = '';
      attachPromptSuggestionHandlers(c);
    }
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
    setCurrentConversationId(urlConversationId);
    isNewConversationMode = false;
    // Load the conversation and show input
    await selectConversation(urlConversationId);
    return urlConversationId;
  }
  
  // Fallback to backend preference
  try {
    const userId = 'dashboard-user';
    const response = await fetch(`${API_URL}/api/user/preferences?userId=${userId}`);
    
    if (!response.ok) {
      // No saved conversation - hide input
      updateInputVisibility(false);
      return null;
    }

    const result = await response.json();
    const conversationId = result.data?.lastActiveConversationId;
    
    if (conversationId) {
      currentConversationId = conversationId;
      setCurrentConversationId(conversationId);
      isNewConversationMode = false;
      // Update URL to match backend preference
      updateConversationUrl(conversationId);
      // Load the conversation and show input
      await selectConversation(conversationId);
      return conversationId;
    } else {
      // No saved conversation - hide input
      updateInputVisibility(false);
    }
  } catch (error) {
    console.error('Failed to restore conversation:', error);
    // On error, hide input
    updateInputVisibility(false);
  }
  
  return null;
}

// Helper functions
function formatClusterNodesSection(nodes) {
  if (nodes.length === 0) {
    return '<div style="margin: 8px 0; padding: 8px 10px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #94a3b8;">No nodes discovered in twin.</div>';
  }
  
  let html = `
    <div style="margin: 8px 0;">
      <div style="padding: 6px 10px; margin-bottom: 4px; background: #0b1220; border: 1px solid #334155; border-radius: 6px; color: #94a3b8; font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.05em;">
        <div style="display: grid; grid-template-columns: minmax(120px, 1.4fr) 80px 90px minmax(140px, 2fr); align-items: center; gap: 8px;">
          <span>Node</span>
          <span>VMs</span>
          <span>Status</span>
          <span>ID</span>
        </div>
      </div>
  `;
  for (const node of nodes) {
    const statusColor = node.status === 'online' ? '#10b981' : node.status === 'offline' ? '#ef4444' : '#94a3b8';
    html += `
      <div style="margin-bottom: 4px; padding: 6px 10px; background: #0f172a; border: 1px solid #334155; border-radius: 6px;">
        <div style="display: grid; grid-template-columns: minmax(120px, 1.4fr) 80px 90px minmax(140px, 2fr); align-items: center; gap: 8px; font-size: 0.9em;">
          <strong style="color: #e2e8f0;">${escapeHtml(node.name)}</strong>
          <span style="color: #f8fafc;">${node.vmCount} VM${node.vmCount !== 1 ? 's' : ''}</span>
          <span style="display: inline-flex; align-items: center; gap: 6px; color: #cbd5e1;">
            <span style="width: 8px; height: 8px; border-radius: 999px; background: ${statusColor}; display: inline-block;"></span>
            ${escapeHtml(node.status)}
          </span>
          <code style="background: #1e293b; padding: 2px 6px; border-radius: 3px; color: #94a3b8; font-family: 'Courier New', monospace; font-size: 0.8em; justify-self: start;">${escapeHtml(node.id)}</code>
        </div>
      </div>
    `;
  }
  html += '</div>';
  return html;
}

function formatClusterVmsSection(vms) {
  if (vms.length === 0) {
    return '<div style="margin: 8px 0; padding: 8px 10px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #94a3b8;">No VMs discovered in twin.</div>';
  }
  
  return `
    <div style="margin: 8px 0;">
      <div style="padding: 6px 10px; margin-bottom: 4px; background: #0b1220; border: 1px solid #334155; border-radius: 6px; color: #94a3b8; font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.05em;">
        <div style="display: grid; grid-template-columns: minmax(130px, 1.7fr) 70px 95px 80px minmax(160px, 2fr); gap: 8px; align-items: center;">
          <span>Name</span>
          <span>Type</span>
          <span>Status</span>
          <span>Node</span>
          <span>Trace</span>
        </div>
      </div>
      ${vms.join('')}
    </div>
  `;
}

/**
 * Format clarification messages with clickable options
 */
function formatClarificationMessage(text) {
  const lines = text.split('\n');
  const encodedText = encodeURIComponent(text);
  let html = `<div class="clarification-message" data-clarification-text="${encodedText}" style="background: linear-gradient(135deg, #1e3a5f 0%, #1e293b 100%); border: 1px solid #3b82f6; border-radius: 8px; padding: 16px;">`;
  
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
      html += `<button type="button"
        data-clarification-option-id="${num}"
        data-clarification-option="${encodeURIComponent(optionText)}"
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
function hashClarificationText(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return `clar_${Math.abs(hash)}`;
}

async function saveClarificationResponse(payload) {
  if (!currentConversationId) return;
  try {
    await fetch(`${API_URL}/api/chat/clarification-responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'dashboard-user',
        conversationId: currentConversationId,
        clarificationId: payload.clarificationId,
        optionId: payload.optionId,
        optionText: payload.optionText,
        clarificationText: payload.clarificationText,
      }),
    });
  } catch (error) {
    console.warn('Failed to persist clarification response', error);
  }
}

function attachClarificationHandlers(container) {
  const buttons = container.querySelectorAll('[data-clarification-option]');
  buttons.forEach((btn) => {
    if (btn.dataset.bound === 'true') return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', async () => {
      const optionText = decodeURIComponent(btn.dataset.clarificationOption || '');
      if (!optionText) return;

      const optionId = btn.dataset.clarificationOptionId || undefined;
      const wrapper = btn.closest('.clarification-message');
      const clarificationTextRaw = wrapper?.getAttribute('data-clarification-text') || '';
      const clarificationText = clarificationTextRaw ? decodeURIComponent(clarificationTextRaw) : '';
      const clarificationId = hashClarificationText(clarificationText || optionText);

      await saveClarificationResponse({
        clarificationId,
        optionId,
        optionText,
        clarificationText,
      });

      sendChatMessage(optionText);
    });
  });
}

function formatAgentResponse(text) {
  if (!text) return '';
  
  // Strip markdown bold (**...**) for cleaner output
  const stripBold = (input) => input.replace(/\*\*(.*?)\*\*/g, '$1');
  const stripAnsi = (input) => input.replace(/\u001b\[[0-9;]*m/g, '');
  text = stripAnsi(stripBold(text));
  
  // Check if this is a clarification message
  if (text.includes('🔍') && text.includes('Did you mean')) {
    return formatClarificationMessage(text);
  }
  
  const lines = text.split('\n');
  let html = '';
  let inVmEntry = false;
  let currentVmName = '';
  let currentVmType = '';
  let currentVmState = '';
  let currentVmNode = '';
  let currentVmTrace = '';
  let currentVmSource = '';
  
  let inClusterNodes = false;
  let inClusterVms = false;
  let pendingNodeField = '';
  let nodeEntries = [];
  let vmList = [];
  let seenVmNames = new Set();
  
  const tryParsePipeKv = (line) => {
    if (!line.includes('|') || !line.includes('=')) return null;
    const parts = line.split('|').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const label = parts[0];
    const fields = [];
    for (const part of parts.slice(1)) {
      const eqIdx = part.indexOf('=');
      if (eqIdx === -1) continue;
      const key = part.slice(0, eqIdx).trim();
      let value = part.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      value = value.replace(/^"(.*)"$/, '$1');
      if (key) fields.push({ key, value });
    }
    if (!fields.length) return null;
    return { label, fields };
  };

  const parseKeyValueBlock = (blockLines) => {
    if (!blockLines.length) return null;
    let idx = 0;
    let title = null;
    const first = blockLines[0]?.trim();
    if (first && /^(error|warning|success|info)$/i.test(first)) {
      title = first;
      idx = 1;
    }
    const entries = [];
    while (idx < blockLines.length) {
      const key = blockLines[idx]?.trim();
      const valueLine = blockLines[idx + 1];
      if (!key || valueLine === undefined) break;
      if (!/^[a-zA-Z][\w-]*$/.test(key)) break;
      if (key.toLowerCase() === 'message') {
        const value = blockLines.slice(idx + 1).join('\n').trim();
        entries.push({ key, value });
        idx = blockLines.length;
        break;
      }
      entries.push({ key, value: valueLine.trim() });
      idx += 2;
    }
    if (entries.length === 0) return null;
    return { title, entries };
  };

  const buildVmRow = (vm) => {
    const stateColor = vm.state === 'running' ? '#10b981' : vm.state === 'stopped' ? '#ef4444' : '#94a3b8';
    const typeColor = vm.type === 'VM' ? '#f97316' : '#ea580c';
    return `
      <div style="margin-bottom: 4px; padding: 7px 10px; background: #0f172a; border: 1px solid #334155; border-radius: 6px;">
        <div style="display: grid; grid-template-columns: minmax(130px, 1.7fr) 70px 95px 80px minmax(160px, 2fr); gap: 8px; align-items: center;">
          <strong style="color: #e2e8f0; font-size: 0.92em; line-height: 1.2;">${escapeHtml(vm.name || '-')}</strong>
          <span style="background: ${typeColor}; color: white; padding: 1px 6px; border-radius: 999px; font-size: 0.62em; font-weight: 600; width: fit-content;">${escapeHtml(vm.type || '-')}</span>
          <span style="display: inline-flex; align-items: center; gap: 6px; color: #cbd5e1; font-size: 0.84em;">
            <span style="width: 8px; height: 8px; border-radius: 999px; background: ${stateColor}; display: inline-block;"></span>
            ${escapeHtml(vm.state || 'unknown')}
          </span>
          <span style="color: #e2e8f0; font-size: 0.84em;">${escapeHtml(vm.node || '-')}</span>
          <span style="display: inline-flex; align-items: center; gap: 6px;">
            <code style="background: #1e293b; padding: 2px 6px; border-radius: 3px; color: #94a3b8; font-family: 'Courier New', monospace; font-size: 0.78em;">${escapeHtml(vm.trace || '-')}</code>
            ${vm.source ? `<span style="font-size: 0.74em; color: #94a3b8;">src:${escapeHtml(vm.source)}</span>` : ''}
          </span>
        </div>
      </div>
    `;
  };

  const flushCurrentVm = () => {
    if (!inVmEntry || !currentVmName) return;
    if (!seenVmNames.has(currentVmName)) {
      vmList.push(buildVmRow({
        name: currentVmName,
        type: currentVmType || 'VM',
        state: currentVmState || 'unknown',
        node: currentVmNode || '',
        trace: currentVmTrace || '',
        source: currentVmSource || '',
      }));
      seenVmNames.add(currentVmName);
    }
    inVmEntry = false;
    currentVmName = '';
    currentVmType = '';
    currentVmState = '';
    currentVmNode = '';
    currentVmTrace = '';
    currentVmSource = '';
  };

  const kvBlock = parseKeyValueBlock(lines);
  if (kvBlock) {
    const title = kvBlock.title || 'Result';
    html += `
      <div class="kv-card">
        <div class="kv-card-header">
          <span class="kv-pill">${escapeHtml(title)}</span>
        </div>
        <div class="kv-grid">
          ${kvBlock.entries.map(entry => {
            const value = entry.value || '';
            const isMultiline = value.includes('\n') || value.includes('│') || value.includes('╷');
            return `
              <div class="kv-row">
                <div class="kv-key">${escapeHtml(entry.key)}</div>
                <div class="kv-value">
                  ${isMultiline
                    ? `<pre class="kv-pre">${escapeHtml(value)}</pre>`
                    : escapeHtml(value)}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
    return html;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Key/value pipe format cards (e.g., Definition | term=... | meaning="..." | context="...")
    const kv = tryParsePipeKv(trimmed);
    if (kv) {
      html += `
        <div class="kv-card">
          <div class="kv-card-header">
            <span class="kv-pill">${escapeHtml(kv.label)}</span>
          </div>
          <div class="kv-grid">
            ${kv.fields.map(f => `
              <div class="kv-row">
                <div class="kv-key">${escapeHtml(f.key)}</div>
                <div class="kv-value">${escapeHtml(f.value)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
      continue;
    }
    
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
      const nodeName = trimmed.replace(/^- /, '').trim();
      if (nodeName) {
        nodeEntries.push({
          name: nodeName,
          id: `compute-node:${nodeName.toLowerCase()}`,
          vmCount: 0,
          status: "unknown",
        });
      }
      continue;
    }
    if (inClusterNodes) {
      const normalized = trimmed.toLowerCase();
      if (normalized === 'id' || normalized === 'vms' || normalized === 'status') {
        pendingNodeField = normalized;
        continue;
      }
      if (pendingNodeField && nodeEntries.length > 0) {
        const node = nodeEntries[nodeEntries.length - 1];
        if (pendingNodeField === 'id') node.id = trimmed;
        if (pendingNodeField === 'vms') node.vmCount = Number.parseInt(trimmed, 10) || 0;
        if (pendingNodeField === 'status') node.status = trimmed.toLowerCase();
        pendingNodeField = '';
        continue;
      }
      // Ignore any other cluster-node lines to prevent noisy paragraphs.
      continue;
    }
    
    if (inClusterVms && trimmed.startsWith('- ') && !trimmed.startsWith('  -')) {
      flushCurrentVm();
      
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
        currentVmType = vmType.includes('QEMU') || vmType === 'QEMU VM' ? 'VM' :
          (vmType.includes('LXC') || vmType === 'LXC container' ? 'LXC' : vmType.trim());
        currentVmState = state.trim();
      }
      continue;
    }
    
    if (inClusterVms && trimmed.startsWith('  - ') && !trimmed.startsWith('    -')) {
      const nestedVmMatch = trimmed.match(/^  - (.+?) \((.+?),\s*(.+?)\)/);
      if (nestedVmMatch) {
        const [, name, vmType, state] = nestedVmMatch;
        const shortType = vmType.includes('QEMU') || vmType === 'QEMU VM' ? 'VM' : 
                         vmType.includes('LXC') || vmType === 'LXC container' ? 'LXC' : vmType.trim();
        vmList.push(buildVmRow({
          name: name.trim(),
          type: shortType,
          state: state.trim(),
          node: '',
          trace: '',
          source: '',
        }));
      }
      continue;
    }
    
    if (inVmEntry && trimmed.startsWith('  - Details:')) {
      const detailsText = trimmed.replace('  - Details:', '').trim();
      const parts = detailsText.split('|').map(p => p.trim());
      for (const part of parts) {
        if (part.startsWith('trace=')) {
          currentVmTrace = part.replace('trace=', '').trim();
        } else if (part.startsWith('node=')) {
          currentVmNode = part.replace('node=', '').trim();
        }
      }
      continue;
    }
    
    if (inVmEntry && trimmed.startsWith('  - Source:')) {
      currentVmSource = trimmed.replace('  - Source:', '').trim();
      continue;
    }
    
    if (trimmed.startsWith('Tip:')) {
      html += `<div style="margin-top: 16px; padding: 10px; background: #1e293b; border-left: 2px solid #f97316; border-radius: 4px; font-size: 0.875em; color: #cbd5e1;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 6px; color: #f97316;">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
        </svg>
        <strong style="color: #f97316;">Tip:</strong> ${escapeHtml(trimmed.replace('Tip:', '').trim())}
      </div>`;
      continue;
    }
    
    if (trimmed.startsWith('### ')) {
      flushCurrentVm();
      
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
      flushCurrentVm();
      
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
    flushCurrentVm();
    if (vmList.length > 0) {
      html += formatClusterVmsSection(vmList);
    }
  }
  
  return html;
}

function updateChatMessage(messageId, newContent) {
  // Update in all containers (mobile + desktop)
  const containersToScroll = new Set();
  const scrollContainer = getChatScrollContainer();
  
  // Ensure containers are visible when updating
  const containers = getChatMessageContainers();
  containers.forEach(c => {
    if (c) {
      c.style.display = '';
    }
  });
  
  containers.forEach(messagesDiv => {
    if (!messagesDiv) return;
    let messageDiv = messagesDiv.querySelector(`#${messageId}`);
    
    // If message not found, create it (fallback for race conditions)
    if (!messageDiv) {
      console.warn(`Message ${messageId} not found, creating fallback message`);
      messageDiv = document.createElement('div');
      messageDiv.id = messageId;
      messageDiv.style.cssText = `
        margin-bottom: 8px;
        padding: 12px 16px;
        border-radius: 18px 18px 18px 4px;
        max-width: 92%;
        word-wrap: break-word;
        position: relative;
        background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
        margin-left: 0;
        margin-right: auto;
        color: #e2e8f0;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(51, 65, 85, 0.5);
      `;
      messagesDiv.appendChild(messageDiv);
    }
    
    // Check if user scrolled up (more than 150px from bottom)
    const { distanceFromBottom } = getScrollMetrics(scrollContainer);
    const wasNearBottom = distanceFromBottom < 150;
    
    // If async operation is active and user hasn't scrolled up, lock to bottom
    const shouldLockScroll = isAsyncOperationActive && (wasNearBottom || shouldAutoScroll);
    
    messageDiv.innerHTML = newContent;
    attachClarificationHandlers(messageDiv);
    
    if (shouldLockScroll || (wasNearBottom && shouldAutoScroll)) {
      if (scrollContainer) containersToScroll.add(scrollContainer);
    }
  });
  
  // Scroll all containers that need scrolling in a single animation frame
  if (containersToScroll.size > 0 && !scrollScheduled) {
    scrollScheduled = true;
    requestAnimationFrame(() => {
      containersToScroll.forEach(container => {
        scrollToBottom(container, 'auto');
        updateScrollToBottomButton(container);
      });
      scrollScheduled = false;
    });
  }
}

/**
 * Lock scroll to bottom during async operations
 */
function lockScrollToBottom() {
  isAsyncOperationActive = true;
  shouldAutoScroll = true;
  
  // Clear any existing timeout
  if (scrollLockTimeout) {
    clearTimeout(scrollLockTimeout);
  }
  
  // Set up scroll lock for all containers
  if (!scrollScheduled) {
    scrollScheduled = true;
    requestAnimationFrame(() => {
      const scrollContainer = getChatScrollContainer();
      if (scrollContainer) {
        scrollToBottom(scrollContainer, 'auto');
        updateScrollToBottomButton(scrollContainer);
      }
      scrollScheduled = false;
    });
  }
  
  // Attach scroll listeners once if not already attached
  const scrollContainer = getChatScrollContainer();
  if (scrollContainerRef && scrollContainerRef !== scrollContainer) {
    scrollContainerRef.removeEventListener('scroll', handleScrollDuringAsync);
    scrollContainerRef = null;
    scrollHandlersAttached = false;
  }
  if (!scrollHandlersAttached) {
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', handleScrollDuringAsync, { passive: true });
      scrollContainerRef = scrollContainer;
    }
    // Initial check for scroll-to-bottom button visibility
    updateScrollToBottomButton(scrollContainer);
    scrollHandlersAttached = true;
  }
}

/**
 * Unlock scroll when async operations complete
 */
function unlockScroll() {
  isAsyncOperationActive = false;
  
  // Clear timeout
  if (scrollLockTimeout) {
    clearTimeout(scrollLockTimeout);
    scrollLockTimeout = null;
  }
  
  // Remove scroll listeners
  getChatMessageContainers().forEach(messagesDiv => {
    if (!messagesDiv) return;
    // We can't remove anonymous listeners, but that's okay - they check isAsyncOperationActive
  });
}

function addChatMessage(role, content, isLoading = false, messageId = null, dbId = null, reasoningTraceId = null) {
  const containers = getChatMessageContainers();
  const msgId = messageId || 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  
  // Show chatbox containers when first message is added
  containers.forEach(c => {
    if (c) {
      c.style.display = '';
    }
  });
  
  // Remove welcome message from all containers
  containers.forEach(c => {
    const welcomeMsg = c.querySelector('div[style*="text-align: center"]');
    if (welcomeMsg) welcomeMsg.remove();
    const suggestions = c.querySelector('[data-pre-chat-suggestions="true"]');
    if (suggestions) suggestions.remove();
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
    max-width: ${isUser ? '78%' : '92%'};
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

  // Append to all containers and collect which ones need scrolling
  const containersToScroll = new Set();
  const scrollContainer = getChatScrollContainer();
  
  containers.forEach(messagesDiv => {
    const clone = messageDiv.cloneNode(true);
    
    // Check scroll position - handle both container and window scroll
    const { distanceFromBottom } = getScrollMetrics(scrollContainer);
    const wasNearBottom = distanceFromBottom < 150;
    
    messagesDiv.appendChild(clone);
    
    // Always scroll for user messages or loading messages
    // For assistant messages, only scroll if user is near bottom or async operation is active
    if (role === 'user' || isLoading || (wasNearBottom && shouldAutoScroll) || (isAsyncOperationActive && shouldAutoScroll)) {
      if (scrollContainer) containersToScroll.add(scrollContainer);
    }
  });
  
  // Scroll all containers that need scrolling in a single animation frame
  if (containersToScroll.size > 0 && !scrollScheduled) {
    scrollScheduled = true;
    requestAnimationFrame(() => {
      containersToScroll.forEach(container => {
        scrollToBottom(container, 'auto');
        updateScrollToBottomButton(container);
      });
      scrollScheduled = false;
    });
  }

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
      // Lock scroll during async operations
      lockScrollToBottom();
      const stepNum = event.data.step ?? '?';
      const maxSteps = event.data.maxSteps ?? '?';
      updateChatMessage(currentResponseId, 
        `<div class="agent-thinking">
          <svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
          Reasoning step ${stepNum}/${maxSteps}...
        </div>`);
      break;
      
    case 'tool:start':
      // Lock scroll during tool execution
      lockScrollToBottom();
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
      // Lock scroll during progress updates
      lockScrollToBottom();
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
      // Lock scroll during tool completion
      lockScrollToBottom();
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
      console.log('Handling agent:final event', event.data);
      const formattedText = formatAgentResponse(event.data.text || 'No response');
      const durationSeconds = (event.data.durationMs || 0) / 1000;
      const traceId = event.data.traceId;
      const confirmationMetaHtml = event.data.confirmationRequired
        ? `
        <div style="margin-top: 12px; padding: 12px; background: #1e293b; border: 1px solid #334155; border-radius: 8px;">
          <div style="color: #e2e8f0; font-weight: 600; margin-bottom: 8px;">Pending change review</div>
          ${event.data.confirmationPreview
            ? `<div style="color: #cbd5e1; margin-bottom: 8px;">${escapeHtml(event.data.confirmationPreview)}</div>`
            : ''}
          <div style="color: #94a3b8; font-size: 0.9em;">
            Confirm with <code style="background: #0f172a; padding: 2px 6px; border-radius: 4px;">CONFIRM ${escapeHtml(event.data.confirmationId || '')}</code>
            or <code style="background: #0f172a; padding: 2px 6px; border-radius: 4px;">CANCEL</code>.
          </div>
        </div>
      `
        : '';
      
      // Ensure containers are visible before updating
      const containers = getChatMessageContainers();
      containers.forEach(c => {
        if (c) {
          c.style.display = '';
        }
      });
      
      // Don't reload chat history - message is already displayed via updateChatMessage
      // Just refresh conversation list to update message counts
      setTimeout(() => {
        loadConversations();
      }, 500);
      
      // Ensure currentResponseId is set
      if (!currentResponseId) {
        console.warn('No currentResponseId set when receiving agent:final event');
        // Create a new message if one doesn't exist
        currentResponseId = addChatMessage('assistant', '', false);
      }
      
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
          ${confirmationMetaHtml}
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
      
      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        updateChatMessage(currentResponseId, finalHtml);
      });
      // Scroll is handled inside updateChatMessage
      
      // Unlock scroll after a short delay to allow final render
      scrollLockTimeout = setTimeout(() => {
        unlockScroll();
      }, 500);
      
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
export async function sendChatMessage(messageOverride = null) {
  const inputs = getChatInputs();
  const buttons = getSendButtons();
  const primaryInput = getPrimaryChatInput();
  
  const message = typeof messageOverride === 'string'
    ? messageOverride.trim()
    : (primaryInput?.value?.trim() || '');
  if (!message) return;

  inputs.forEach(i => { i.disabled = true; i.value = ''; });
  buttons.forEach(b => b.disabled = true);

  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }

  addChatMessage('user', message);
  
  // Re-enable auto-scroll when user sends a new message
  shouldAutoScroll = true;
  lockScrollToBottom();

  currentResponseId = addChatMessage('assistant', `
    <div class="agent-thinking">
      <svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
      Thinking...
    </div>
  `, true);

  try {
    // Create conversation only when first message is sent (not when clicking "New")
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
          isNewConversationMode = false; // No longer in "new" mode, we have a real conversation
          await saveLastActiveConversation(currentConversationId); // Save to backend
          updateConversationUrl(currentConversationId); // Update URL
          await loadConversations();
        } else {
          throw new Error(`Failed to create conversation: ${createResponse.status} ${createResponse.statusText}`);
        }
      } catch (error) {
        console.error('Failed to create conversation:', error);
        // Re-enable inputs on error
        inputs.forEach(i => { i.disabled = false; });
        buttons.forEach(b => { b.disabled = false; });
        throw error; // Re-throw to show error message
      }
    }

    // IMPORTANT: subscribe to SSE BEFORE starting the agent.
    // The agent can return very fast (e.g., greetings/clarifications), and if we subscribe after,
    // the UI can miss `agent:final` and get stuck in "Thinking..." until refresh.
    currentSessionId = `session-ui-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    let toolExecutions = [];
    let finalText = '';
    const currentQuery = message;

    currentEventSource = new EventSource(`${API_URL}/api/agent/stream?sessionId=${currentSessionId}`);
    currentEventSource.onmessage = (event) => {
      try {
        const agentEvent = JSON.parse(event.data);
        console.log('Received SSE event:', agentEvent.type, agentEvent);
        handleAgentEvent(agentEvent, toolExecutions);
        
        if (agentEvent.type === 'agent:final') {
          finalText = agentEvent.data.text || '';
          console.log('Final text received:', finalText);
        }
      } catch (error) {
        console.error('Error parsing SSE event:', error, event.data);
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
        
        // Re-enable inputs and buttons
        const inputs = getChatInputs();
        const buttons = getSendButtons();
        inputs.forEach(i => { i.disabled = false; });
        buttons.forEach(b => { 
          b.disabled = false;
          b.textContent = 'Send';
        });
        const primaryInput = getPrimaryChatInput();
        if (primaryInput) primaryInput.focus();
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
        
        // Re-enable inputs and buttons
        const inputs = getChatInputs();
        const buttons = getSendButtons();
        inputs.forEach(i => { i.disabled = false; });
        buttons.forEach(b => { 
          b.disabled = false;
          b.textContent = 'Send';
        });
        const primaryInput = getPrimaryChatInput();
        if (primaryInput) primaryInput.focus();
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
        
        // Re-enable inputs and buttons
        const inputs = getChatInputs();
        const buttons = getSendButtons();
        inputs.forEach(i => { i.disabled = false; });
        buttons.forEach(b => { 
          b.disabled = false;
          b.textContent = 'Send';
        });
        const primaryInput = getPrimaryChatInput();
        if (primaryInput) primaryInput.focus();
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

    const startResponse = await fetch(`${API_URL}/api/agent/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        query: message, 
        userId: 'dashboard-user', 
        aclGroup: 'admin',
        conversationId: currentConversationId,
        sessionId: currentSessionId
      })
    });

    if (!startResponse.ok) {
      throw new Error(`HTTP ${startResponse.status}: ${startResponse.statusText}`);
    }

    const startResult = await startResponse.json();
    // If backend returned a different sessionId (shouldn't), resubscribe.
    if (startResult.sessionId && startResult.sessionId !== currentSessionId) {
      currentSessionId = startResult.sessionId;
      if (currentEventSource) currentEventSource.close();
      currentEventSource = new EventSource(`${API_URL}/api/agent/stream?sessionId=${currentSessionId}`);
    }
    
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

  } catch (error) {
    if (currentResponseId) {
      removeChatMessage(currentResponseId);
    }
    
    addChatMessage('assistant', `<div style="color: #ef4444;">Error: ${escapeHtml(error.message)}</div>`);
    
    if (currentEventSource) {
      currentEventSource.close();
      currentEventSource = null;
    }
    if (finalEventTimeout) {
      clearTimeout(finalEventTimeout);
      finalEventTimeout = null;
    }
    
    // Re-enable inputs and buttons
    const inputs = getChatInputs();
    const buttons = getSendButtons();
    inputs.forEach(i => { i.disabled = false; });
    buttons.forEach(b => { 
      b.disabled = false;
      b.textContent = 'Send';
    });
    const primaryInput = getPrimaryChatInput();
    if (primaryInput) primaryInput.focus();
  }
}

export async function loadConversations() {
  const selectEl = document.getElementById('conversation-select');
  if (!selectEl) return;

  try {
    const userId = 'dashboard-user';
    const response = await fetch(`${API_URL}/api/chat/conversations?userId=${userId}`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    const conversations = result.data || [];

    // Populate dropdown
    selectEl.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = conversations.length ? 'Select a conversation…' : 'No conversations yet';
    selectEl.appendChild(placeholder);

    conversations.forEach((conv) => {
      const opt = document.createElement('option');
      opt.value = conv.id;
      const title = conv.title || 'New Conversation';
      const count = conv.messageCount || 0;
      opt.textContent = `${title} (${count})`;
      selectEl.appendChild(opt);
    });

    // Keep selection in sync with current conversation
    if (currentConversationId) {
      selectEl.value = currentConversationId;
    } else {
      selectEl.value = '';
    }

    // Attach change handler once
    if (!selectEl.dataset.bound) {
      selectEl.addEventListener('change', async () => {
        const selected = selectEl.value;
        if (!selected) return;
        await selectConversation(selected);
      });
      selectEl.dataset.bound = '1';
    }
  } catch (error) {
    console.error('Failed to load conversations:', error);
    selectEl.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Failed to load conversations';
    selectEl.appendChild(opt);
  }
}

export async function selectConversation(conversationId) {
  currentConversationId = conversationId;
  setCurrentConversationId(conversationId);
  isNewConversationMode = false; // No longer in "new" mode when selecting existing conversation
  await saveLastActiveConversation(conversationId); // Save to backend
  
  // Update URL for sharing/bookmarking
  updateConversationUrl(conversationId);
  
  await loadChatHistory(conversationId);
  updateInputVisibility(true); // Show input when conversation is selected
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

/**
 * Prepare UI for a new conversation (doesn't create backend conversation yet)
 * Backend conversation is created only when first message is sent
 */
export async function createNewConversation() {
  // Prevent spamming the button
  if (isCreatingConversation) {
    return;
  }
  
  isCreatingConversation = true;
  
  // Disable buttons visually
  const newButtons = [document.getElementById('conversation-new-btn')].filter(Boolean);
  
  const reenableButtons = () => {
    newButtons.forEach(btn => {
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.cursor = '';
      }
    });
  };
  
  newButtons.forEach(btn => {
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = '0.6';
      btn.style.cursor = 'not-allowed';
    }
  });
  
  try {
    // Clear current conversation state
    currentConversationId = null;
    setCurrentConversationId(null);
    isNewConversationMode = true;
    
    // Clear URL conversation param
    updateConversationUrl(null);
    
    // Clear chat messages and show suggested prompts
    const containers = getChatMessageContainers();
    containers.forEach(c => {
      if (c) {
        c.innerHTML = '<div class="text-slate-400 text-center py-6 text-sm">Loading suggestions...</div>';
      }
    });
    await renderPreChatSuggestions();
    
    // Show input box (it will be shown by updateInputVisibility)
    updateInputVisibility(true);
    
    // Focus input
    const primaryInput = getPrimaryChatInput();
    if (primaryInput) {
      setTimeout(() => primaryInput.focus(), 100);
    }
    
    // Refresh conversation list to update active state
    await loadConversations();
  } catch (error) {
    console.error('Failed to prepare new conversation:', error);
    alert('Failed to prepare new conversation: ' + error.message);
  } finally {
    // Re-enable button after a short delay to prevent rapid clicking
    setTimeout(() => {
      isCreatingConversation = false;
      reenableButtons();
    }, 500);
  }
}

/**
 * Update input box visibility based on conversation state
 * @param {boolean} forceShow - Force show even if no conversation (for new conversation mode)
 */
function updateInputVisibility(forceShow = false) {
  const hasActiveConversation = currentConversationId !== null;
  const shouldShow = forceShow || hasActiveConversation || isNewConversationMode;
  
  const inputContainers = [
    document.querySelector('#chat-input-desktop')?.parentElement,
    document.querySelector('#chat-input')?.parentElement
  ].filter(Boolean);
  
  inputContainers.forEach(container => {
    if (container) {
      if (shouldShow) {
        container.style.display = '';
      } else {
        container.style.display = 'none';
      }
    }
  });
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
      isNewConversationMode = false;
      await saveLastActiveConversation(null); // Clear from backend
      updateConversationUrl(null); // Clear from URL
      
      // Clear all message containers
      const containers = getChatMessageContainers();
      containers.forEach(c => {
        if (c) {
          c.innerHTML = '<div class="text-slate-400 text-center py-6 text-sm">Select a conversation or create a new one to start chatting.</div>';
        }
      });
      
      // Hide input when no conversation is selected
      updateInputVisibility(false);
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

export async function deleteAllConversations() {
  showConfirm({
    title: 'Delete All Chats',
    message: 'Delete all conversations and messages for this user? This cannot be undone.',
    confirmText: 'Delete All',
    cancelText: 'Cancel',
    onConfirm: async () => {
      try {
        const userId = 'dashboard-user';
        const response = await fetch(`${API_URL}/api/chat/conversations?userId=${userId}`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Clear local state
        currentConversationId = null;
        setCurrentConversationId(null);
        isNewConversationMode = false;
        await saveLastActiveConversation(null);
        updateConversationUrl(null);

        // Clear all message containers
        const containers = getChatMessageContainers();
        containers.forEach(c => {
          if (c) {
            c.innerHTML = '<div class="text-slate-400 text-center py-6 text-sm">All conversations have been deleted. Start a new one to begin chatting.</div>';
          }
        });

        // Hide input until a new conversation is created
        updateInputVisibility(false);

        // Refresh conversation list (will now be empty)
        await loadConversations();
      } catch (error) {
        console.error('Failed to delete all conversations:', error);
        alert('Failed to delete all conversations: ' + error.message);
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
    // Show placeholder when no conversation is selected
    containers.forEach(c => {
      if (c) {
        c.innerHTML = '<div class="text-slate-400 text-center py-6 text-sm">Select a conversation or create a new one to start chatting.</div>';
        c.style.display = '';
      }
    });
    updateInputVisibility(false); // Hide input when no conversation
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

    // Hide chatbox containers for empty conversations
    // The chatbox will appear when the first message is sent
    if (messages.length === 0) {
      containers.forEach(c => {
        if (c) {
          c.style.display = 'none';
        }
      });
      return;
    }
    
    // Show chatbox containers when there are messages
    containers.forEach(c => {
      if (c) {
        c.style.display = '';
      }
    });
    
    // Show input when conversation has messages
    updateInputVisibility(true);

    messages.forEach(msg => {
      if (msg.role === 'user') {
        addChatMessage('user', msg.content, false, null, msg.id, null);
      } else {
        const formattedContent = formatAgentResponse(msg.content);
        addChatMessage('assistant', formattedContent, false, null, msg.id, msg.reasoningTraceId || null);
      }
    });

    // Scroll to bottom in the active scroll container
    // Disable async scroll lock during history load (not an async operation)
    const wasAsyncActive = isAsyncOperationActive;
    isAsyncOperationActive = false;

    const scrollContainer = getChatScrollContainer();
    requestAnimationFrame(() => {
      scrollToBottom(scrollContainer, 'auto');
      requestAnimationFrame(() => {
        scrollToBottom(scrollContainer, 'auto');
        // Update button visibility after scroll
        updateScrollToBottomButton(scrollContainer);
      });
    });
    
    // Restore async state
    isAsyncOperationActive = wasAsyncActive;
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
window.deleteAllConversations = deleteAllConversations;
