import { API_URL, escapeHtml } from './utils.js';
import { createButton } from './components.js';
import { showConfirm } from './modal.js';
import { renderAssistantResponse, renderConnectionEndpoints } from './response-renderer.js';

/**
 * Copy trace ID to clipboard. Uses data-trace-id on the button to avoid
 * embedding the ID in onclick (which can break with quotes or long IDs).
 * Handles clipboard API errors (e.g. non-secure context) with visual feedback.
 */
function copyTraceIdToClipboard(buttonEl) {
  const id = buttonEl?.getAttribute?.('data-trace-id');
  if (!id) return;
  const labelHtml = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Trace: ${escapeHtml(id.substring(0, 8))}...`;
  navigator.clipboard.writeText(id).then(() => {
    const prev = buttonEl.innerHTML;
    buttonEl.innerHTML = 'Copied!';
    setTimeout(() => {
      buttonEl.innerHTML = prev;
    }, 1200);
  }).catch(() => {
    const prev = buttonEl.innerHTML;
    buttonEl.title = 'Copy failed – ID: ' + id;
    buttonEl.innerHTML = 'Copy failed';
    setTimeout(() => {
      buttonEl.innerHTML = prev;
      buttonEl.title = 'Copy trace ID';
    }, 2000);
  });
}
// Expose for inline onclick (trace buttons use data-trace-id + this to avoid quoting issues)
window.copyTraceIdToClipboard = copyTraceIdToClipboard;

function renderTraceFooter(traceId) {
  if (!traceId) return "";
  const safeTraceId = escapeHtml(traceId);
  const shortTraceId = escapeHtml(traceId.substring(0, 8));
  return `
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(51,65,85,0.38);display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:#64748b;font-size:0.72em;">
      <button
        data-trace-id="${safeTraceId}"
        onclick="window.copyTraceIdToClipboard(this)"
        style="background:transparent;border:none;color:#64748b;padding:0;cursor:pointer;display:inline-flex;align-items:center;gap:4px;font-size:1em;"
        title="Copy trace ID"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
        </svg>
        trace ${shortTraceId}
      </button>
      <span style="color:#334155;">/</span>
      <button
        onclick="window.switchTab('reasoning', null); setTimeout(() => { const traces = document.getElementById('reasoning-traces'); if (traces) traces.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 300);"
        style="background:transparent;border:none;color:#94a3b8;padding:0;cursor:pointer;font-size:1em;text-decoration:underline;text-underline-offset:2px;"
        title="View reasoning trace"
      >view trace</button>
    </div>
  `;
}

/**
 * Copy text from a button's data-copyable attribute (e.g. SSH command in VM create message).
 */
function copyCopyableText(buttonEl) {
  const text = buttonEl?.getAttribute?.('data-copyable');
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const prev = buttonEl.textContent;
    buttonEl.textContent = 'Copied!';
    setTimeout(() => {
      buttonEl.textContent = prev;
    }, 1200);
  }).catch(() => {
    buttonEl.textContent = 'Copy failed';
    setTimeout(() => {
      buttonEl.textContent = 'Copy';
    }, 2000);
  });
}
window.copyCopyableText = copyCopyableText;

/**
 * Format message value for display. If it contains "Connect with: ssh ...", render that part
 * as a markdown-style copyable code block with a Copy button.
 */
function formatMessageValue(key, value) {
  if (!value || typeof value !== 'string') return escapeHtml(value);
  const connectMatch = value.match(/^(.+?)\s+Connect with:\s*(ssh\s+\S+?)\s*\.?\s*$/);
  if (key !== 'message' || !connectMatch) {
    return escapeHtml(value);
  }
  const before = connectMatch[1].trim();
  const command = connectMatch[2].trim().replace(/\.+$/, '');
  return escapeHtml(before) + `
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(51,65,85,0.5);">
      <div style="color:#94a3b8;font-size:0.85em;margin-bottom:6px;">Connect with:</div>
      <pre style="margin:0;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;font-size:0.9em;color:#e2e8f0;font-family:ui-monospace,monospace;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <code style="flex:1;min-width:0;word-break:break-all;">${escapeHtml(command)}</code>
        <button type="button" data-copyable="${escapeHtml(command)}" onclick="window.copyCopyableText(this)" style="flex-shrink:0;background:rgba(249,115,22,0.2);border:1px solid rgba(249,115,22,0.5);color:#f97316;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.8em;font-weight:600;">Copy</button>
      </pre>
    </div>
  `;
}

// Chat state
let currentEventSource = null;
let currentSessionId = null;
let currentResponseId = null;
let finalEventTimeout = null;
let currentConversationId = null;
let agentRunStatus = 'idle';
let agentStatusPoll = null;
let isNewConversationMode = true; // Keep composer visible even before first conversation exists
let isCreatingConversation = false; // Prevent spamming New Chat button
let promptSuggestionCache = null;
let promptSuggestionCacheAt = 0;
const PROMPT_SUGGESTIONS_TTL_MS = 5 * 60 * 1000;
const PROMPT_SUGGESTION_REFRESH_FEEDBACK_MS = 3000;
let promptSuggestionsRefreshing = false;
let promptSuggestionsFeedbackUntil = 0;
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

function setComposerAgentState(status) {
  agentRunStatus = status;
  const active = status === 'running' || status === 'stopping';
  getChatInputs().forEach(input => { input.disabled = active; });

  getSendButtons().forEach(button => {
    const isDesktop = button.id === 'chat-send-btn-desktop';
    button.disabled = status === 'stopping';
    button.setAttribute('aria-label', active ? (status === 'stopping' ? 'Stopping agent' : 'Stop agent') : 'Send message');
    button.title = active ? (status === 'stopping' ? 'Stopping…' : 'Stop response') : 'Send message';
    if (active) {
      button.innerHTML = `
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px"><path d="M7 5h3v14H7V5zm7 0h3v14h-3V5z"/></svg>
        ${isDesktop ? `<span>${status === 'stopping' ? 'Stopping…' : 'Stop'}</span>` : ''}
      `;
    } else {
      button.innerHTML = `
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2 .01 7z"/></svg>
        ${isDesktop ? '<span>Send</span>' : ''}
      `;
    }
  });
}

function stopAgentStatusPolling() {
  if (agentStatusPoll) clearInterval(agentStatusPoll);
  agentStatusPoll = null;
}

async function reconcileAgentRunState() {
  const params = new URLSearchParams({ userId: USER_ID });
  if (currentSessionId) params.set('sessionId', currentSessionId);
  const response = await fetch(`${API_URL}/api/agent/status?${params}`, { cache: 'no-store' });
  if (!response.ok) return;
  const state = await response.json();
  if (state.active && state.sessionId) currentSessionId = state.sessionId;
  setComposerAgentState(state.status || 'idle');
  if (!state.active) {
    stopAgentStatusPolling();
    currentSessionId = null;
    if (currentConversationId) loadChatHistory(currentConversationId);
    const primaryInput = getPrimaryChatInput();
    if (primaryInput) primaryInput.focus();
  }
}

function startAgentStatusPolling() {
  stopAgentStatusPolling();
  agentStatusPoll = setInterval(() => {
    reconcileAgentRunState().catch(error => console.warn('Failed to reconcile agent state', error));
  }, 2000);
}

async function stopCurrentAgentRun() {
  if (agentRunStatus !== 'running') return;
  setComposerAgentState('stopping');
  try {
    const response = await fetch(`${API_URL}/api/agent/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId, conversationId: currentConversationId }),
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`HTTP ${response.status}`);
    }
    startAgentStatusPolling();
  } catch (error) {
    console.error('Failed to stop agent run', error);
    await reconcileAgentRunState().catch(() => setComposerAgentState('running'));
  }
}

function getAgentWorkingLabel(message) {
  if (/^cancel\b/i.test(message)) return 'Cancelling the pending change…';
  if (/^confirm\b/i.test(message)) return 'Confirming the pending change…';
  return 'Palindrome is working…';
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

async function fetchPromptSuggestionsWithOptions(options = {}) {
  const { forceRefresh = false } = options;
  const now = Date.now();
  if (!forceRefresh && promptSuggestionCache && (now - promptSuggestionCacheAt) < PROMPT_SUGGESTIONS_TTL_MS) {
    return promptSuggestionCache;
  }

  try {
    const query = forceRefresh ? `?refresh=1&ts=${now}` : "";
    const response = await fetch(
      `${API_URL}/api/dashboard/prompt-suggestions${query}`,
      { cache: "no-store" }
    );
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

  if (promptSuggestionCache && promptSuggestionCache.length > 0) {
    return promptSuggestionCache;
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

  const refreshBtn = container.querySelector("[data-refresh-suggestions]");
  if (refreshBtn && refreshBtn.dataset.bound !== "true") {
    refreshBtn.dataset.bound = "true";
    refreshBtn.addEventListener("click", async () => {
      if (promptSuggestionsRefreshing) return;
      promptSuggestionsRefreshing = true;
      promptSuggestionsFeedbackUntil = 0;
      try {
        await renderPreChatSuggestions({ forceRefresh: true });
        promptSuggestionsFeedbackUntil = Date.now() + PROMPT_SUGGESTION_REFRESH_FEEDBACK_MS;
      } finally {
        promptSuggestionsRefreshing = false;
        await renderPreChatSuggestions();
        setTimeout(() => {
          if (Date.now() >= promptSuggestionsFeedbackUntil) {
            promptSuggestionsFeedbackUntil = 0;
            renderPreChatSuggestions().catch((error) => {
              console.warn("Failed to clear refresh feedback", error);
            });
          }
        }, PROMPT_SUGGESTION_REFRESH_FEEDBACK_MS + 100);
      }
    });
  }
}

async function renderPreChatSuggestions(options = {}) {
  const { forceRefresh = false } = options;
  if (!isNewConversationMode) return;
  const containers = getChatMessageContainers();
  if (containers.length === 0) return;

  const suggestions = await fetchPromptSuggestionsWithOptions({ forceRefresh });
  const showRefreshFeedback = Date.now() < promptSuggestionsFeedbackUntil;
  const refreshButtonLabel = promptSuggestionsRefreshing
    ? "Refreshing..."
    : "Refresh suggestions";
  const refreshButtonStateClass = promptSuggestionsRefreshing
    ? "border-primary-400/80 text-primary-200 bg-primary-500/20 shadow-[0_0_20px_rgba(249,115,22,0.28)]"
    : "border-slate-700 text-slate-300 hover:border-primary-500 hover:text-primary-300";
  const refreshStatusLabel = showRefreshFeedback
    ? '<div class="text-emerald-400 text-xs font-medium">Suggestions updated just now</div>'
    : '<div class="text-slate-500 text-xs"> </div>';
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
      <div class="flex items-center justify-between gap-3 mb-4">
        <div>
          <div class="text-slate-400 text-sm">Suggested prompts</div>
          ${refreshStatusLabel}
        </div>
        <button
          type="button"
          data-refresh-suggestions="true"
          class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all duration-200 ${refreshButtonStateClass}"
          ${promptSuggestionsRefreshing ? "disabled" : ""}
        >
          <svg
            class="${promptSuggestionsRefreshing ? "spin" : ""}"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 0 1 15.55-6.36L21 8"></path>
            <path d="M21 3v5h-5"></path>
            <path d="M21 12a9 9 0 0 1-15.55 6.36L3 16"></path>
            <path d="M3 21v-5h5"></path>
          </svg>
          ${refreshButtonLabel}
        </button>
      </div>
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

const USER_ID = 'dashboard-user';
const PROFILE_SELECTION_STORAGE_KEY = 'activeProfileUserId';

function isValidPublicKeyInput(value) {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    trimmed.startsWith('ssh-ed25519 ') ||
    trimmed.startsWith('ssh-rsa ') ||
    trimmed.startsWith('ecdsa-sha2-')
  );
}

function getStoredProfileSelection() {
  try {
    return localStorage.getItem(PROFILE_SELECTION_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function persistProfileSelection(userId) {
  try {
    localStorage.setItem(PROFILE_SELECTION_STORAGE_KEY, userId || '');
  } catch {
    // Non-fatal
  }
}

function getSelectedProfileUserId() {
  const selectEl = document.getElementById('profile-select');
  if (selectEl && typeof selectEl.value === 'string' && selectEl.value.trim()) {
    return selectEl.value.trim();
  }
  const stored = getStoredProfileSelection();
  return stored || USER_ID;
}

function populateProfileSelector(profiles) {
  const selectEl = document.getElementById('profile-select');
  if (!selectEl) return;

  selectEl.innerHTML = '';
  if (!Array.isArray(profiles) || profiles.length === 0) {
    const opt = document.createElement('option');
    opt.value = USER_ID;
    opt.textContent = 'Default (dashboard-user)';
    selectEl.appendChild(opt);
    selectEl.value = USER_ID;
    persistProfileSelection(USER_ID);
    return;
  }

  const stored = getStoredProfileSelection();
  const hasStored = stored && profiles.some((p) => p.userId === stored);
  const hasDefault = profiles.some((p) => p.userId === USER_ID);
  const selected = hasStored ? stored : (hasDefault ? USER_ID : profiles[0].userId);

  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.userId;
    const label = p.displayName || p.sshUsername || p.userId;
    const keyState = p.hasPublicKey ? 'key set' : 'no key';
    opt.textContent = `${label} (${keyState})`;
    selectEl.appendChild(opt);
  }

  selectEl.value = selected;
  persistProfileSelection(selected);

  if (!selectEl.dataset.bound) {
    selectEl.dataset.bound = '1';
    selectEl.addEventListener('change', () => {
      persistProfileSelection(selectEl.value || USER_ID);
    });
  }
}

function renderProfileItem(profile) {
  const name = escapeHtml(profile.displayName || profile.sshUsername || profile.userId);
  const username = escapeHtml(profile.sshUsername || '');
  const keyBadge = profile.hasPublicKey
    ? '<span class="chat-profile-key-badge chat-profile-key-badge-set">Key set</span>'
    : '<span class="chat-profile-key-badge">No key</span>';
  const userId = escapeHtml(profile.userId);
  return `
    <div class="chat-profile-item">
      <div class="chat-profile-copy">
        <span class="chat-profile-name">${name}</span>
        <div class="chat-profile-meta">
          <span>${username}</span>
          <span aria-hidden="true">/</span>
          ${keyBadge}
        </div>
      </div>
      <div class="chat-profile-actions">
        <button type="button" onclick="window._editProfile('${userId}')"
          class="chat-profile-icon-btn"
          title="Edit profile">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button type="button" onclick="window._deleteProfile('${userId}')"
          class="chat-profile-icon-btn chat-profile-icon-btn-danger"
          title="Delete profile">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM5 4h14v2H5zM9 3h6v1H9z"/>
          </svg>
        </button>
      </div>
    </div>`;
}

async function loadAllProfiles() {
  const listEl = document.getElementById('profile-list');
  if (!listEl) return;
  try {
    const response = await fetch(`${API_URL}/api/user/profiles`);
    if (!response.ok) {
      listEl.innerHTML = '<div style="color:#f87171;font-size:0.72rem;padding:4px 4px;">Failed to load profiles</div>';
      return;
    }
    const result = await response.json();
    const profiles = result.data || [];
    populateProfileSelector(profiles);
    if (profiles.length === 0) {
      listEl.innerHTML = '<div style="color:#475569;font-size:0.72rem;padding:4px 4px;">No profiles — add one above</div>';
      return;
    }
    listEl.innerHTML = profiles.map(renderProfileItem).join('');
  } catch (error) {
    console.error('Failed to load profiles', error);
    listEl.innerHTML = '<div style="color:#f87171;font-size:0.72rem;padding:4px 4px;">Could not reach API</div>';
  }
}

function showProfileForm({ userId = '', displayName = '', sshUsername = 'ops', hasKey = false } = {}) {
  const formEl = document.getElementById('profile-form');
  if (!formEl) return;
  document.getElementById('profile-form-userid').value = userId;
  document.getElementById('profile-form-name').value = displayName;
  document.getElementById('profile-form-username').value = sshUsername;
  const keyEl = document.getElementById('profile-form-key');
  keyEl.value = '';
  keyEl.placeholder = hasKey ? 'Leave blank to keep existing key' : 'SSH public key (e.g. ssh-ed25519 AAAA…)';
  const statusEl = document.getElementById('profile-form-status');
  if (statusEl) statusEl.textContent = '';
  formEl.classList.remove('hidden');
  document.getElementById('profile-form-name').focus();
}

async function _editProfile(userId) {
  try {
    const response = await fetch(`${API_URL}/api/user/profile?userId=${encodeURIComponent(userId)}`);
    if (!response.ok) return;
    const result = await response.json();
    const p = result.data || {};
    showProfileForm({
      userId: p.userId,
      displayName: p.displayName || '',
      sshUsername: p.sshUsername || 'ops',
      hasKey: !!p.publicKey,
    });
  } catch (error) {
    console.error('Failed to load profile for editing', error);
  }
}

async function _deleteProfile(userId) {
  if (!confirm('Delete this profile?')) return;
  try {
    const response = await fetch(`${API_URL}/api/user/profile?userId=${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
    if (response.ok) {
      const selected = getSelectedProfileUserId();
      if (selected === userId) {
        persistProfileSelection(USER_ID);
      }
      await loadAllProfiles();
    }
  } catch (error) {
    console.error('Failed to delete profile', error);
  }
}

async function saveProfileForm() {
  const useridEl = document.getElementById('profile-form-userid');
  const nameEl = document.getElementById('profile-form-name');
  const usernameEl = document.getElementById('profile-form-username');
  const keyEl = document.getElementById('profile-form-key');
  const statusEl = document.getElementById('profile-form-status');

  const isEdit = !!(useridEl && useridEl.value);
  const displayName = nameEl ? nameEl.value.trim() : '';
  const sshUsername = usernameEl ? (usernameEl.value.trim() || 'ops') : 'ops';
  const publicKey = keyEl ? keyEl.value.trim() : '';

  if (!displayName && !sshUsername) {
    if (statusEl) { statusEl.textContent = 'Enter a profile name'; statusEl.style.color = '#f87171'; }
    return;
  }
  if (publicKey && !isValidPublicKeyInput(publicKey)) {
    if (statusEl) { statusEl.textContent = 'Invalid key format'; statusEl.style.color = '#f87171'; }
    return;
  }

  const userId = isEdit
    ? useridEl.value
    : (displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile-' + Date.now());

  if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.style.color = '#94a3b8'; }

  try {
    const body = { userId, displayName: displayName || null, sshUsername };
    if (publicKey) body.publicKey = publicKey;
    else if (!isEdit) body.publicKey = null;

    const response = await fetch(`${API_URL}/api/user/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
      if (statusEl) { statusEl.textContent = result.error || 'Save failed'; statusEl.style.color = '#f87171'; }
      return;
    }
    document.getElementById('profile-form')?.classList.add('hidden');
    await loadAllProfiles();
  } catch (error) {
    if (statusEl) { statusEl.textContent = 'Save failed'; statusEl.style.color = '#f87171'; }
  }
}

// Kept for backward-compat (called from main.js on chat tab load)
export async function loadUserProfile() {
  await loadAllProfiles();
}

export function initProfileSection() {
  const addBtn = document.getElementById('profile-add-btn');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', () => showProfileForm());
  }
  const cancelBtn = document.getElementById('profile-form-cancel');
  if (cancelBtn && !cancelBtn.dataset.bound) {
    cancelBtn.dataset.bound = '1';
    cancelBtn.addEventListener('click', () => {
      document.getElementById('profile-form')?.classList.add('hidden');
    });
  }
  const saveBtn = document.getElementById('profile-form-save');
  if (saveBtn && !saveBtn.dataset.bound) {
    saveBtn.dataset.bound = '1';
    saveBtn.addEventListener('click', saveProfileForm);
  }
  window._editProfile = _editProfile;
  window._deleteProfile = _deleteProfile;
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
      // No saved conversation - keep input visible for first message
      updateInputVisibility(true);
      await reconcileAgentRunState().catch(() => {});
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
      // No saved conversation - keep input visible for first message
      updateInputVisibility(true);
      await reconcileAgentRunState().catch(() => {});
    }
  } catch (error) {
    console.error('Failed to restore conversation:', error);
    // On error, keep input visible so Safari/network glitches don't block chat
    updateInputVisibility(true);
  }
  
  return null;
}

// Assistant response rendering lives in response-renderer.js.

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

  const traceLink = role === 'assistant' ? renderTraceFooter(reasoningTraceId) : '';

  if (role === 'user') {
    messageDiv.innerHTML = `<div style="white-space: pre-wrap; line-height: 1.4; font-size: 15px;">${escapeHtml(content)}</div>`;
  } else {
    const innerContent = isLoading
      ? `<div style="color: #94a3b8; font-style: italic;">${content}</div>`
      : content;
    messageDiv.innerHTML = `<div style="line-height: 1.5; font-size: 15px;">${innerContent}${traceLink}</div>`;
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
    case 'connection:update': {
      lockScrollToBottom();
      const panelHtml = `
        <div class="connection-live-panel" data-connection-panel>
          <div class="connection-live-title">${event.data.phase === 'complete' ? 'Connection verification complete' : 'Verifying connections…'}</div>
          ${renderConnectionEndpoints(event.data.endpoints)}
        </div>`;
      getChatMessageContainers().forEach(container => {
        const message = container.querySelector(`#${currentResponseId}`);
        if (!message) return;
        const existing = message.querySelector('[data-connection-panel]');
        if (existing) existing.outerHTML = panelHtml;
        else message.insertAdjacentHTML('beforeend', panelHtml);
      });
      break;
    }

    case 'agent:step':
      // Lock scroll during async operations
      lockScrollToBottom();
      const stepNum = event.data.step ?? '?';
      const maxSteps = event.data.maxSteps ?? '?';
      const stepLabel = (maxSteps === 1 || maxSteps === '1')
        ? 'Working on it...'
        : `Step ${stepNum} of ${maxSteps}...`;
      updateChatMessage(currentResponseId,
        `<div class="agent-thinking">
          <svg class="icon spin" viewBox="0 0 24 24" fill="currentColor"><path d="M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8c-.45-.83-.7-1.79-.7-2.8 0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z"/></svg>
          ${stepLabel}
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
      
      const isActionTool = event.data.toolName === 'action';
      const actionName = event.data.parameters?.action || '';
      const actionNode = event.data.parameters?.params?.node || event.data.parameters?.node || '';
      const paramsStr = isActionTool
        ? `${actionName}${actionNode ? ` on ${actionNode}` : ''}`
        : Object.entries(event.data.parameters || {})
            .map(([k, v]) => `${k}=${typeof v === 'string' ? v.substring(0, 30) : JSON.stringify(v).substring(0, 30)}`)
            .join(', ');
      const executingLabel = isActionTool
        ? 'Applying changes — this may take a few minutes...'
        : 'Executing...';

      const toolHtml = `
        <div data-tool-name="${escapeHtml(event.data.toolName)}" style="margin-top: 8px; padding: 8px 10px; background: #1e3a8a; border-radius: 4px; font-size: 0.85em;">
          <svg class="icon" viewBox="0 0 24 24" fill="currentColor" style="color: #f97316;"><path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>
          <strong style="color: #e2e8f0;">${escapeHtml(event.data.toolName)}</strong>
          ${paramsStr ? `<div style="color: #94a3b8; margin-top: 4px; font-size: 0.9em;">${escapeHtml(paramsStr)}</div>` : ''}
          <div style="color: #94a3b8; margin-top: 4px; font-size: 0.9em;">
            <svg class="icon spin" viewBox="0 0 24 24" fill="currentColor" style="width: 14px; height: 14px;"><path d="M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8c-.45-.83-.7-1.79-.7-2.8 0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z"/></svg>
            ${executingLabel}
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
            Palindrome is working…
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
      const formattedText = renderAssistantResponse(event.data);
      const durationSeconds = (event.data.durationMs || 0) / 1000;
      const traceId = event.data.traceId;
      const confirmId = escapeHtml(event.data.confirmationId || '');
      const confirmationMetaHtml = event.data.confirmationRequired
        ? `
        <div style="margin-top: 14px; padding: 14px 16px; background: #1e293b; border: 1px solid rgba(249, 115, 22, 0.4); border-radius: 10px;">
          <div style="display: flex; align-items: center; gap: 6px; color: #f97316; font-weight: 600; font-size: 0.875em; margin-bottom: 8px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
            Pending Change
          </div>
          ${event.data.confirmationPreview
            ? `<div style="color: #e2e8f0; margin-bottom: 12px; font-size: 0.95em;">${escapeHtml(event.data.confirmationPreview)}</div>`
            : ''}
          <div data-confirm-buttons="${confirmId}" style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button
              onclick="window.handleConfirmAction('${confirmId}', this)"
              style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; padding: 8px 18px; border-radius: 8px; cursor: pointer; font-size: 0.875em; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; transition: opacity 0.15s;"
              onmouseover="this.style.opacity='0.88'" onmouseout="this.style.opacity='1'"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
              Confirm
            </button>
            <button
              onclick="window.handleCancelAction('${confirmId}', this)"
              style="background: rgba(239, 68, 68, 0.12); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.35); padding: 8px 18px; border-radius: 8px; cursor: pointer; font-size: 0.875em; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; transition: background 0.15s;"
              onmouseover="this.style.background='rgba(239,68,68,0.22)'" onmouseout="this.style.background='rgba(239,68,68,0.12)'"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              Cancel
            </button>
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
      
      const traceLinkHtml = renderTraceFooter(traceId);
      
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
      
      // The final response can be emitted just before runner cleanup completes.
      // Keep the composer locked until the server reports the run as truly idle.
      startAgentStatusPolling();
      reconcileAgentRunState().catch(error => console.warn('Failed to confirm final agent state', error));
      break;
  }
}

function bindAgentEventSourceHandlers(eventSource, toolExecutions) {
  let finalResponse = null;

  eventSource.onmessage = (event) => {
    try {
      const agentEvent = JSON.parse(event.data);
      console.log('Received SSE event:', agentEvent.type, agentEvent);
      handleAgentEvent(agentEvent, toolExecutions);

      if (agentEvent.type === 'agent:final') {
        finalResponse = agentEvent.data;
        console.log('Final response received:', finalResponse);
      }
    } catch (error) {
      console.error('Error parsing SSE event:', error, event.data);
    }
  };

  eventSource.onerror = (error) => {
    console.error('SSE connection error:', error);

    if (finalEventTimeout) {
      clearTimeout(finalEventTimeout);
      finalEventTimeout = null;
    }

    if (currentEventSource && currentEventSource.readyState === EventSource.CLOSED) {
      if (finalResponse) {
        updateChatMessage(currentResponseId, `
          <div class="agent-response" style="line-height: 1.6;">
            ${renderAssistantResponse(finalResponse)}
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

      startAgentStatusPolling();
    }

    if (currentEventSource) {
      currentEventSource.close();
      currentEventSource = null;
    }
  };

  return () => finalResponse;
}

// Main chat functions
export async function sendChatMessage(messageOverride = null) {
  if (agentRunStatus === 'running') {
    await stopCurrentAgentRun();
    return;
  }
  if (agentRunStatus === 'stopping') return;

  const inputs = getChatInputs();
  const buttons = getSendButtons();
  const primaryInput = getPrimaryChatInput();
  
  const message = typeof messageOverride === 'string'
    ? messageOverride.trim()
    : (primaryInput?.value?.trim() || '');
  if (!message) return;

  inputs.forEach(i => { i.value = ''; });
  setComposerAgentState('running');

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
      ${escapeHtml(getAgentWorkingLabel(message))}
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
    let finalResponse = null;
    const currentQuery = message;

    currentEventSource = new EventSource(`${API_URL}/api/agent/stream?sessionId=${currentSessionId}`);
    const getFinalResponse = bindAgentEventSourceHandlers(currentEventSource, toolExecutions);

    finalEventTimeout = setTimeout(() => {
      finalResponse = getFinalResponse();
      if (currentEventSource && finalResponse) {
        updateChatMessage(currentResponseId, `
          <div class="agent-response" style="line-height: 1.6;">
            ${renderAssistantResponse(finalResponse)}
          </div>
          ${toolExecutions.length > 0 ? `
            <div style="margin-top: 16px; padding: 10px; background: #0f172a; border-top: 1px solid #334155; border-radius: 0 0 6px 6px; color: #94a3b8; font-size: 0.85em;">
              Executed ${toolExecutions.length} tool${toolExecutions.length !== 1 ? 's' : ''}
            </div>
          ` : ''}
        `);
        
        currentEventSource.close();
        currentEventSource = null;
        
        startAgentStatusPolling();
        reconcileAgentRunState().catch(error => console.warn('Failed to confirm final agent state', error));
      } else if (currentEventSource && !finalResponse) {
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
        
        setComposerAgentState('running');
        startAgentStatusPolling();
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
        userId: USER_ID,
        profileUserId: getSelectedProfileUserId(),
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
      bindAgentEventSourceHandlers(currentEventSource, toolExecutions);
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
    
    setComposerAgentState('idle');
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
  await reconcileAgentRunState().catch(error => console.warn('Failed to load agent state', error));
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
    await renderPreChatSuggestions({ forceRefresh: true });
    
    // Show input box (it will be shown by updateInputVisibility)
    updateInputVisibility(true);
    await reconcileAgentRunState().catch(error => console.warn('Failed to load agent state', error));
    
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
        const formattedContent = renderAssistantResponse(msg);
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

/**
 * Disable all confirmation button groups in the chat (prevents double-submit).
 * Called by handleConfirmAction and handleCancelAction before sending the message.
 */
function disableAllConfirmationButtons() {
  document.querySelectorAll('[data-confirm-buttons]').forEach(wrapper => {
    wrapper.querySelectorAll('button').forEach(btn => {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
      btn.onmouseover = null;
      btn.onmouseout = null;
    });
  });
}

window.handleConfirmAction = function(confirmId, _btn) {
  disableAllConfirmationButtons();
  sendChatMessage(`CONFIRM ${confirmId}`);
};

window.handleCancelAction = function(_confirmId, _btn) {
  disableAllConfirmationButtons();
  sendChatMessage('CANCEL');
};

// Make functions globally accessible for onclick handlers
window.sendChatMessage = sendChatMessage;
window.selectConversation = selectConversation;
window.createNewConversation = createNewConversation;
window.deleteConversation = deleteConversation;
window.deleteChatMessage = deleteChatMessage;
window.deleteAllConversations = deleteAllConversations;
