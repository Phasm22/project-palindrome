import { API_URL, escapeHtml, renderResponsiveTable } from './utils.js';
import { createButton } from './components.js';
import { showConfirm } from './modal.js';

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
    ? '<span style="color:#34d399;font-size:0.7rem;">Key set</span>'
    : '<span style="color:#475569;font-size:0.7rem;">No key</span>';
  const userId = escapeHtml(profile.userId);
  return `
    <div class="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-slate-900/50 border border-slate-800/70" style="min-width:0;">
      <div class="flex flex-col min-w-0 flex-1" style="gap:1px;">
        <span style="color:#e2e8f0;font-size:0.78rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</span>
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="color:#64748b;font-size:0.7rem;">${username}</span>
          <span style="color:#334155;font-size:0.7rem;">•</span>
          ${keyBadge}
        </div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0;">
        <button type="button" onclick="window._editProfile('${userId}')"
          style="color:#475569;padding:4px;border-radius:4px;background:none;border:none;cursor:pointer;display:flex;align-items:center;"
          title="Edit profile"
          onmouseover="this.style.color='#fb923c'" onmouseout="this.style.color='#475569'">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button type="button" onclick="window._deleteProfile('${userId}')"
          style="color:#475569;padding:4px;border-radius:4px;background:none;border:none;cursor:pointer;display:flex;align-items:center;"
          title="Delete profile"
          onmouseover="this.style.color='#f87171'" onmouseout="this.style.color='#475569'">
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
    }
  } catch (error) {
    console.error('Failed to restore conversation:', error);
    // On error, keep input visible so Safari/network glitches don't block chat
    updateInputVisibility(true);
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
        <div style="display: grid; grid-template-columns: minmax(130px, 1.8fr) 70px 95px 100px; gap: 8px; align-items: center;">
          <span>Name</span>
          <span>Type</span>
          <span>Status</span>
          <span>Node</span>
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

  const stripInlineCode = (input) => String(input ?? '').replace(/`([^`]+)`/g, '$1');

  const parseAnswerEvidenceResponse = (raw) => {
    const source = String(raw ?? '').trim();
    const lines = source.split('\n');
    const answerIndex = lines.findIndex((line) => /^Answer:\s*/i.test(line.trim()));
    if (answerIndex === -1) return null;

    const evidenceIndex = lines.findIndex((line, index) => index > answerIndex && /^Evidence:\s*$/i.test(line.trim()));
    const detailsIndex = lines.findIndex((line, index) => index > answerIndex && /^Details:\s*$/i.test(line.trim()));
    const answerEnd = [evidenceIndex, detailsIndex].filter((index) => index !== -1).sort((a, b) => a - b)[0] ?? lines.length;
    const answerLines = lines.slice(answerIndex, answerEnd);
    if (!answerLines.length) return null;

    const answerMarkdown = answerLines
      .join('\n')
      .replace(/^Answer:\s*/i, '')
      .trim();
    if (!answerMarkdown) return null;

    const evidenceEnd = detailsIndex !== -1 ? detailsIndex : lines.length;
    const evidence = evidenceIndex === -1
      ? []
      : lines.slice(evidenceIndex + 1, evidenceEnd)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.replace(/^-+\s*/, ''))
          .map((line) => {
            const separatorIndex = line.indexOf(':');
            if (separatorIndex <= 0) {
              return { key: '', value: stripInlineCode(line) };
            }
            return {
              key: stripInlineCode(line.slice(0, separatorIndex).trim()),
              value: stripInlineCode(line.slice(separatorIndex + 1).trim()),
            };
          });

    const details = detailsIndex === -1
      ? ''
      : lines.slice(detailsIndex + 1)
          .join('\n')
          .replace(/^```[a-zA-Z0-9_-]*\n?/, '')
          .replace(/\n?```$/, '')
          .trim();

    const inlineCodeValues = [...answerMarkdown.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const aliasMatch = answerMarkdown.match(/^Alias\s+`?([^`]+?)`?\s+contains\s+(\d+)\s+entries?:\s+(.+)\.?$/i);
    const alias = aliasMatch
      ? {
          name: inlineCodeValues[0] || aliasMatch[1].trim(),
          count: Number.parseInt(aliasMatch[2], 10) || 0,
          entries: inlineCodeValues.length > 1
            ? inlineCodeValues.slice(1)
            : aliasMatch[3]
                .replace(/\.$/, '')
                .split(',')
                .map((entry) => stripInlineCode(entry.trim()))
                .filter(Boolean),
        }
      : null;

    return {
      answer: stripInlineCode(answerMarkdown),
      evidence,
      details,
      alias,
    };
  };

  const renderAnswerEvidenceResponse = (raw) => {
    const parsed = parseAnswerEvidenceResponse(raw);
    if (!parsed) return null;

    const renderStatusValue = (key, value) => {
      const normalizedKey = key.toLowerCase();
      const normalizedValue = value.toLowerCase();
      if (normalizedKey === 'enabled') {
        const enabled = /^(yes|true|1|enabled)$/i.test(value);
        const color = enabled ? '#10b981' : '#94a3b8';
        const background = enabled ? 'rgba(16, 185, 129, 0.12)' : 'rgba(148, 163, 184, 0.12)';
        return `<span style="display:inline-flex;align-items:center;border:1px solid ${color};background:${background};color:${color};border-radius:999px;padding:2px 8px;font-size:0.82em;font-weight:700;">${escapeHtml(value)}</span>`;
      }
      if (/^(yes|no)$/i.test(value) && /(blocked|allowed|match|enabled|active|found)/i.test(normalizedKey)) {
        const positive = normalizedValue === 'yes';
        const color = positive ? '#10b981' : '#f87171';
        const background = positive ? 'rgba(16, 185, 129, 0.12)' : 'rgba(248, 113, 113, 0.12)';
        return `<span style="display:inline-flex;align-items:center;border:1px solid ${color};background:${background};color:${color};border-radius:999px;padding:2px 8px;font-size:0.82em;font-weight:700;">${escapeHtml(value)}</span>`;
      }
      return escapeHtml(value || '-');
    };

    const evidenceHtml = parsed.evidence.length
      ? `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px;margin-top:12px;">
          ${parsed.evidence.map((item) => `
            <div style="min-width:0;padding:8px 10px;background:rgba(15,23,42,0.64);border:1px solid rgba(51,65,85,0.72);border-radius:8px;">
              ${item.key
                ? `<div style="color:#94a3b8;font-size:0.75em;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px;">${escapeHtml(item.key)}</div>`
                : ''}
              <div style="color:#e2e8f0;font-size:0.92em;line-height:1.35;word-break:break-word;">${renderStatusValue(item.key, item.value)}</div>
            </div>
          `).join('')}
        </div>
      `
      : '';

    const detailsHtml = parsed.details
      ? `
        <details style="margin-top:12px;border-top:1px solid rgba(51,65,85,0.72);padding-top:10px;">
          <summary style="cursor:pointer;color:#fdba74;font-size:0.84em;font-weight:700;">Details</summary>
          <pre class="kv-pre" style="margin-top:8px;">${escapeHtml(parsed.details)}</pre>
        </details>
      `
      : '';

    if (parsed.alias) {
      const entries = parsed.alias.entries.length
        ? parsed.alias.entries
        : [`No entries returned`];
      return `
        <div style="display:grid;gap:12px;">
          <div>
            <div style="color:#f8fafc;font-size:1.02em;font-weight:700;line-height:1.35;">${escapeHtml(parsed.alias.name)} contains ${escapeHtml(String(parsed.alias.count || entries.length))} ${entries.length === 1 ? 'entry' : 'entries'}</div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:7px;">
            ${entries.map((entry) => `
              <span style="display:inline-flex;align-items:center;min-height:26px;background:rgba(249,115,22,0.14);border:1px solid rgba(249,115,22,0.45);color:#fed7aa;border-radius:999px;padding:4px 9px;font-size:0.86em;font-weight:650;line-height:1.2;">${escapeHtml(entry)}</span>
            `).join('')}
          </div>
          ${evidenceHtml}
          ${detailsHtml}
        </div>
      `;
    }

    return `
      <div style="display:grid;gap:10px;">
        <div style="color:#f8fafc;font-size:1.02em;font-weight:700;line-height:1.4;">${escapeHtml(parsed.answer)}</div>
        ${evidenceHtml}
        ${detailsHtml}
      </div>
    `;
  };

  const semanticAnswerHtml = renderAnswerEvidenceResponse(text);
  if (semanticAnswerHtml) {
    return semanticAnswerHtml;
  }
  
  // Check if this is a clarification message
  if (text.includes('🔍') && text.includes('Did you mean')) {
    return formatClarificationMessage(text);
  }

  // Canonical entity-list contract: "Section title" then "- name | key=value | key=value" lines (shared with formatter)
  const parseCanonicalEntityList = (raw) => {
    const lineList = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lineList.length < 2) return null;
    let title = '';
    const entries = [];
    for (let i = 0; i < lineList.length; i++) {
      const line = lineList[i];
      if (!line.startsWith('- ') || !line.includes('|')) {
        if (entries.length === 0) title = line.replace(/:$/, '').trim();
        continue;
      }
      const rest = line.slice(2).trim();
      const segments = rest.split('|').map((s) => s.trim()).filter(Boolean);
      if (segments.length < 2) continue;
      const label = segments[0];
      const fields = [];
      for (const seg of segments.slice(1)) {
        const eqIdx = seg.indexOf('=');
        const colonIdx = seg.indexOf(':');
        if (eqIdx > 0) {
          const key = seg.slice(0, eqIdx).trim();
          let value = seg.slice(eqIdx + 1).trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"');
          if (key) fields.push({ key, value });
        } else if (colonIdx > 0) {
          const key = seg.slice(0, colonIdx).trim();
          const value = seg.slice(colonIdx + 1).trim();
          if (key) fields.push({ key, value });
        }
      }
      if (fields.length) entries.push({ label, fields });
    }
    return entries.length >= 1 && title ? { title, entries } : null;
  };
  const canonicalSection = parseCanonicalEntityList(text);
  if (canonicalSection) {
    const sectionHtml = `
      <h3 style="margin: 16px 0 8px 0; color: #f97316; font-size: 1.1em; font-weight: 600;">${escapeHtml(canonicalSection.title)}</h3>
      ${canonicalSection.entries.map((e) => `
        <div class="kv-card" style="margin-bottom: 8px;">
          <div class="kv-card-header">
            <span class="kv-pill">${escapeHtml(e.label)}</span>
          </div>
          <div class="kv-grid">
            ${e.fields.map((f) => `
              <div class="kv-row">
                <div class="kv-key">${escapeHtml(f.key)}</div>
                <div class="kv-value">${escapeHtml(f.value)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    `;
    return sectionHtml;
  }
  
  const lines = text.split('\n');
  let html = '';
  let inVmEntry = false;
  let currentVmName = '';
  let currentVmType = '';
  let currentVmSectionType = 'VM';
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

  const parseMarkdownTable = (tableLines) => {
    if (!Array.isArray(tableLines) || tableLines.length < 2) return null;
    const trimmed = tableLines.map((l) => (l ?? '').trim());

    const isHeaderLine = (line) => line.startsWith('|') && line.endsWith('|') && line.includes('|');
    const isSeparatorLine = (line, expectedColumns) => {
      if (!line.startsWith('|') || !line.includes('-')) return false;
      const segments = line.split('|').slice(1, -1).map((s) => s.trim()).filter(Boolean);
      if (!segments.length || (expectedColumns && segments.length !== expectedColumns)) return false;
      return segments.every((seg) => /^:?-{3,}:?$/.test(seg));
    };

    for (let i = 0; i < trimmed.length - 1; i++) {
      const headerLine = trimmed[i];
      if (!isHeaderLine(headerLine)) continue;

      const separatorLine = trimmed[i + 1];
      if (!separatorLine) continue;

      const headerCells = headerLine
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim())
        .filter(Boolean);
      if (!headerCells.length) continue;

      if (!isSeparatorLine(separatorLine, headerCells.length)) continue;

      const rows = [];
      let j = i + 2;
      for (; j < trimmed.length; j++) {
        const rowLine = trimmed[j];
        if (!rowLine || !rowLine.trim().startsWith('|')) break;
        const cells = rowLine
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim());
        if (cells.length !== headerCells.length) break;
        rows.push(cells);
      }

      if (!rows.length) return null;
      return {
        headers: headerCells,
        rows,
        startIndex: i,
        endIndex: j - 1,
      };
    }

    return null;
  };
  
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
      // Decode escaped quotes from historical trace payloads.
      value = value.replace(/\\"/g, '"');
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

  const parsePipeColonSummary = (line) => {
    if (!line.includes("|") || !line.includes(":")) return null;
    const fields = line
      .split("|")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => {
        const index = segment.indexOf(":");
        if (index <= 0 || index === segment.length - 1) return null;
        return {
          key: segment.slice(0, index).trim(),
          value: segment.slice(index + 1).trim(),
        };
      })
      .filter(Boolean);
    return fields.length >= 2 ? fields : null;
  };

  const buildOperationStatusCard = (title, fields) => {
    const normalized = new Map(
      fields.map((field) => [field.key.toLowerCase().replace(/\s+/g, "_"), field.value])
    );
    const status = normalized.get("status") || normalized.get("state") || "unknown";
    const operation = normalized.get("operation") || normalized.get("action") || "";
    const isDestructive = /\b(destroy|delete|remove|terminate|permanent)\b/i.test(
      `${title} ${status} ${operation}`
    );
    const accent = isDestructive ? "#ef4444" : "#f97316";
    const accentSoft = isDestructive ? "rgba(239, 68, 68, 0.12)" : "rgba(249, 115, 22, 0.12)";
    const statusBadge = `<span style="display:inline-flex;align-items:center;gap:6px;background:${accent};color:#fff;padding:4px 10px;border-radius:999px;font-size:0.72em;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;">${escapeHtml(status)}</span>`;
    const opBadge = operation
      ? `<span style="display:inline-flex;align-items:center;gap:6px;background:${accentSoft};color:${accent};border:1px solid ${accent};padding:4px 10px;border-radius:999px;font-size:0.72em;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;">${escapeHtml(operation)}</span>`
      : "";

    const detailRows = fields
      .filter((field) => !["status", "state", "operation", "action"].includes(field.key.toLowerCase()))
      .map((field) => {
        const valueHtml = formatMessageValue(field.key, field.value);
        return `
          <div style="display:flex;gap:8px;align-items:flex-start;min-width:0;">
            <span style="color:#94a3b8;font-size:0.78em;font-weight:600;min-width:70px;">${escapeHtml(field.key)}</span>
            <span style="color:#e2e8f0;font-size:0.88em;word-break:break-word;">${valueHtml}</span>
          </div>
        `;
      })
      .join("");

    return `
      <div style="margin: 4px 0; padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(51, 65, 85, 0.7); background: linear-gradient(135deg, rgba(15, 23, 42, 0.95) 0%, rgba(30, 41, 59, 0.72) 100%); box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
          <div style="color:${accent};font-weight:700;letter-spacing:0.01em;font-size:0.95em;">${escapeHtml(title)}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">${statusBadge}${opBadge}</div>
        </div>
        <div style="display:grid;gap:6px;">${detailRows || '<span style="color:#94a3b8;font-size:0.85em;">No additional details.</span>'}</div>
      </div>
    `;
  };

  const buildVmRow = (vm) => {
    const stateColor = vm.state === 'running' ? '#10b981' : vm.state === 'stopped' ? '#ef4444' : '#94a3b8';
    const typeColor = vm.type === 'VM' ? '#f97316' : '#ea580c';
    return `
      <div style="margin-bottom: 4px; padding: 7px 10px; background: #0f172a; border: 1px solid #334155; border-radius: 6px;">
        <div style="display: grid; grid-template-columns: minmax(130px, 1.8fr) 70px 95px 100px; gap: 8px; align-items: center;">
          <strong style="color: #e2e8f0; font-size: 0.92em; line-height: 1.2;">${escapeHtml(vm.name || '-')}</strong>
          <span style="background: ${typeColor}; color: white; padding: 1px 6px; border-radius: 999px; font-size: 0.62em; font-weight: 600; width: fit-content;">${escapeHtml(vm.type || '-')}</span>
          <span style="display: inline-flex; align-items: center; gap: 6px; color: #cbd5e1; font-size: 0.84em;">
            <span style="width: 8px; height: 8px; border-radius: 999px; background: ${stateColor}; display: inline-block;"></span>
            ${escapeHtml(vm.state || 'unknown')}
          </span>
          <span style="color: #e2e8f0; font-size: 0.84em;">${escapeHtml(vm.node || '-')}</span>
        </div>
      </div>
    `;
  };

  const flushCurrentVm = () => {
    if (!inVmEntry || !currentVmName) return;
    if (!seenVmNames.has(currentVmName)) {
      vmList.push(buildVmRow({
        name: currentVmName,
        type: currentVmType || currentVmSectionType || 'VM',
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

  const markdownTable = parseMarkdownTable(lines);
  if (markdownTable) {
    const before = lines.slice(0, markdownTable.startIndex).join('\n').trim();
    const after = lines.slice(markdownTable.endIndex + 1).join('\n').trim();

    const tableHtml = renderResponsiveTable(
      markdownTable.headers,
      markdownTable.rows,
      (row) => row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')
    );

    const beforeHtml = before ? `<div class="agent-response">${escapeHtml(before)}</div>` : '';
    const afterHtml = after ? `<div class="agent-response" style="margin-top: 1rem;">${escapeHtml(after)}</div>` : '';

    return `${beforeHtml}${tableHtml}${afterHtml}`;
  }

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

  const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean);
  if (nonEmptyLines.length >= 2) {
    const summaryTitle = nonEmptyLines[0].replace(/:$/, "");
    const summaryFields = parsePipeColonSummary(nonEmptyLines[1]);
    if (summaryFields && /(status|result|operation|vm|task|action)/i.test(summaryTitle)) {
      return buildOperationStatusCard(summaryTitle, summaryFields);
    }
  }
  if (nonEmptyLines.length === 1) {
    const summaryFields = parsePipeColonSummary(nonEmptyLines[0]);
    if (summaryFields) {
      return buildOperationStatusCard("Operation Summary", summaryFields);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Key/value pipe format cards (e.g., Definition | term=... | meaning="..." | context="...")
    // Skip VM detail/source list lines so they stay attached to the VM row parser.
    const isVmListDetailLine = inClusterVms && /^- (Details|Source):/i.test(trimmed);
    if (!isVmListDetailLine) {
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
                  <div class="kv-value" style="word-break:break-word;">${formatMessageValue(f.key, f.value)}</div>
                </div>
              `).join('')}
            </div>
          </div>
        `;
        continue;
      }
    }
    
    const isVmInventoryHeading = /^(Cluster VMs|LXC Containers|VMs on node .+|Running .+\b(?:VMs?|LXC|containers?)\b|All .+\b(?:VMs?|LXC|containers?)\b)$/i.test(trimmed.replace(/:$/, ''));
    if ((trimmed.endsWith(':') || isVmInventoryHeading) && !trimmed.startsWith('-')) {
      if (inClusterNodes && nodeEntries.length > 0) {
        html += formatClusterNodesSection(nodeEntries);
        nodeEntries = [];
      }
      if (inClusterVms && vmList.length > 0) {
        html += formatClusterVmsSection(vmList);
        vmList = [];
      }
      
      const sectionName = trimmed.replace(/:$/, '');
      if (sectionName === 'Cluster Nodes') {
        inClusterNodes = true;
        inClusterVms = false;
        currentVmSectionType = 'VM';
      } else if (
        sectionName === 'Cluster VMs' ||
        sectionName.includes('VMs') ||
        /\b(lxc|container)\b/i.test(sectionName)
      ) {
        inClusterNodes = false;
        inClusterVms = true;
        currentVmSectionType = /\b(lxc|container)\b/i.test(sectionName) ? 'LXC' : 'VM';
      } else {
        inClusterNodes = false;
        inClusterVms = false;
        currentVmSectionType = 'VM';
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
    
    if (inClusterVms && /^- /.test(trimmed) && !/^- (Details|Source):/i.test(trimmed)) {
      flushCurrentVm();

      const inlineSegments = trimmed
        .replace(/^- /, '')
        .split('|')
        .map(part => part.trim())
        .filter(Boolean);
      if (inlineSegments.length > 1 && inlineSegments.some(part => /^status\s*:/i.test(part))) {
        const vmName = inlineSegments[0] || '';
        if (!seenVmNames.has(vmName)) {
          let inlineState = 'unknown';
          let inlineNode = '';
          let inlineTrace = '';
          let inlineSource = '';
          let inlineDetails = '';

          for (const segment of inlineSegments.slice(1)) {
            if (/^status\s*:/i.test(segment)) {
              inlineState = segment.replace(/^status\s*:/i, '').trim() || 'unknown';
            } else if (/^node\s*[:=]/i.test(segment)) {
              inlineNode = segment.replace(/^node\s*[:=]/i, '').trim();
            } else if (/^details\s*:/i.test(segment)) {
              inlineDetails = segment.replace(/^details\s*:/i, '').trim();
            } else if (/^trace\s*[:=]/i.test(segment)) {
              inlineTrace = segment.replace(/^trace\s*[:=]/i, '').trim();
            } else if (/^source\s*:/i.test(segment)) {
              inlineSource = segment.replace(/^source\s*:/i, '').trim();
            }
          }

          if (!inlineNode && /node[:=]/i.test(inlineDetails)) {
            const detailsNodeMatch = inlineDetails.match(/node\s*[:=]\s*([^|]+)/i);
            if (detailsNodeMatch?.[1]) inlineNode = detailsNodeMatch[1].trim();
          }
          if (!inlineTrace && inlineDetails.includes('trace=')) {
            const detailsTraceMatch = inlineDetails.match(/trace=([^|]+)/i);
            if (detailsTraceMatch?.[1]) inlineTrace = detailsTraceMatch[1].trim();
          }

          vmList.push(buildVmRow({
            name: vmName,
            type: currentVmType || currentVmSectionType || 'VM',
            state: inlineState,
            node: inlineNode,
            trace: inlineTrace,
            source: inlineSource,
          }));
          seenVmNames.add(vmName);
        }
        inVmEntry = false;
        continue;
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
        currentVmType = vmType.includes('QEMU') || vmType === 'QEMU VM' ? 'VM' :
          (vmType.includes('LXC') || vmType === 'LXC container' ? 'LXC' : vmType.trim());
        currentVmState = state.trim();
      }
      continue;
    }
    
    if (inVmEntry && /^- Details:/i.test(trimmed)) {
      const detailsText = trimmed.replace(/^- Details:/i, '').trim();
      const parts = detailsText.split('|').map(p => p.trim());
      for (const part of parts) {
        if (/^trace\s*[:=]/i.test(part)) {
          currentVmTrace = part.replace(/^trace\s*[:=]/i, '').trim();
        } else if (/^node\s*[:=]/i.test(part)) {
          currentVmNode = part.replace(/^node\s*[:=]/i, '').trim();
        }
      }
      continue;
    }
    
    if (inVmEntry && /^- Source:/i.test(trimmed)) {
      currentVmSource = trimmed.replace(/^- Source:/i, '').trim();
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
    
    if (trimmed.startsWith('## ')) {
      flushCurrentVm();
      const headerText = trimmed.replace(/^## /, '');
      html += `<h2 style="margin: 20px 0 10px 0; color: #f97316; font-size: 1.2em; font-weight: 700; border-bottom: 1px solid #334155; padding-bottom: 4px;">${escapeHtml(headerText)}</h2>`;
      continue;
    }

    if (trimmed.startsWith('# ')) {
      flushCurrentVm();
      const headerText = trimmed.replace(/^# /, '');
      html += `<h1 style="margin: 20px 0 12px 0; color: #f97316; font-size: 1.35em; font-weight: 700; border-bottom: 1px solid #475569; padding-bottom: 6px;">${escapeHtml(headerText)}</h1>`;
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
      processedLine = processedLine.replace(/`([^`]+)`/g, '<code style="background: #0f172a; padding: 2px 6px; border-radius: 4px; color: #fb923c; font-family: monospace; font-size: 0.85em; border: 1px solid #334155;">$1</code>');
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

// --- Structured response rendering (AgentResponseV1) ---

function renderAgentMessage(eventData) {
  // Try structured response first
  if (eventData.structuredResponse) {
    const html = renderStructuredResponse(eventData.structuredResponse);
    if (html) return html;
  }
  // Fallback to existing heuristic
  return formatAgentResponse(eventData.rawTextFallback || eventData.text || "");
}

function renderStructuredResponse(sr) {
  if (!sr || sr.version !== "1") return null;
  const parts = [];
  if (sr.answer?.summary) parts.push(`<p class="summary">${escapeHtml(sr.answer.summary)}</p>`);
  for (const section of sr.answer?.sections ?? []) {
    parts.push(renderSection(section));
  }
  return parts.join("") || null;
}

function renderSection(section) {
  switch (section.type) {
    case "facts":        return renderFactsSection(section);
    case "table":        return renderTableSection(section);
    case "plan":         return renderPlanSection(section);
    case "risk":         return renderRiskSection(section);
    case "next_steps":   return renderNextStepsSection(section);
    case "clarification": return renderClarificationSection(section);
    case "confirmation":  return renderConfirmationSection(section);
    default: return `<pre>${escapeHtml(JSON.stringify(section.data, null, 2))}</pre>`;
  }
}

function renderFactsSection(section) {
  const title = section.title ? `<h4>${escapeHtml(section.title)}</h4>` : "";
  const items = (section.data || []).map(item =>
    `<li><strong>${escapeHtml(item.key || item.label || "")}</strong>: ${escapeHtml(String(item.value ?? ""))}</li>`
  ).join("");
  return `${title}<ul class="facts-list">${items}</ul>`;
}

function renderTableSection(section) {
  const title = section.title ? `<h4>${escapeHtml(section.title)}</h4>` : "";
  if (!section.data?.headers || !section.data?.rows) return title;
  const headers = section.data.headers.map(h => `<th>${escapeHtml(h)}</th>`).join("");
  const rows = section.data.rows.map(row =>
    `<tr>${row.map(cell => `<td>${escapeHtml(String(cell ?? ""))}</td>`).join("")}</tr>`
  ).join("");
  return `${title}<table class="response-table"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderPlanSection(section) {
  const title = section.title ? `<h4>${escapeHtml(section.title)}</h4>` : "";
  const steps = (section.data?.steps || []).map((step, i) =>
    `<li><strong>Step ${step.stepNumber || i + 1}</strong>: ${escapeHtml(step.action || "")}${step.rationale ? ` — <em>${escapeHtml(step.rationale)}</em>` : ""}</li>`
  ).join("");
  return `${title}<ol class="plan-steps">${steps}</ol>`;
}

function renderRiskSection(section) {
  return `<pre>${escapeHtml(JSON.stringify(section.data, null, 2))}</pre>`;
}

function renderNextStepsSection(section) {
  return `<pre>${escapeHtml(JSON.stringify(section.data, null, 2))}</pre>`;
}

function renderClarificationSection(section) {
  return `<pre>${escapeHtml(JSON.stringify(section.data, null, 2))}</pre>`;
}

function renderConfirmationSection(section) {
  return `<pre>${escapeHtml(JSON.stringify(section.data, null, 2))}</pre>`;
}

// --- End structured response rendering ---

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
        data-trace-id="${escapeHtml(reasoningTraceId)}"
        onclick="window.copyTraceIdToClipboard(this)"
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
        Trace: ${escapeHtml(reasoningTraceId.substring(0, 8))}...
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
      const formattedText = renderAgentMessage(event.data);
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
      
      const traceLinkHtml = traceId ? `
        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(51, 65, 85, 0.5); display: flex; align-items: center; gap: 8px; font-size: 0.8em;">
          <button
            data-trace-id="${escapeHtml(traceId)}"
            onclick="window.copyTraceIdToClipboard(this)"
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
            Trace: ${escapeHtml(traceId.substring(0, 8))}...
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

function bindAgentEventSourceHandlers(eventSource, toolExecutions) {
  let finalText = "";

  eventSource.onmessage = (event) => {
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

  eventSource.onerror = (error) => {
    console.error('SSE connection error:', error);

    if (finalEventTimeout) {
      clearTimeout(finalEventTimeout);
      finalEventTimeout = null;
    }

    if (currentEventSource && currentEventSource.readyState === EventSource.CLOSED) {
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

    if (currentEventSource) {
      currentEventSource.close();
      currentEventSource = null;
    }
  };

  return () => finalText;
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
    const getFinalText = bindAgentEventSourceHandlers(currentEventSource, toolExecutions);

    finalEventTimeout = setTimeout(() => {
      finalText = getFinalText();
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
    await renderPreChatSuggestions({ forceRefresh: true });
    
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
