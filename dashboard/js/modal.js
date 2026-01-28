// Modal/Overlay framework with accessibility and focus management
import { createPortal, removeFromPortal } from './portal.js';

let activeModal = null;
let focusableElements = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Trap focus within modal
 */
function trapFocus(modal) {
  const focusable = Array.from(modal.querySelectorAll(focusableElements));
  const firstFocusable = focusable[0];
  const lastFocusable = focusable[focusable.length - 1];
  
  function handleTab(e) {
    if (e.key !== 'Tab') return;
    
    if (e.shiftKey) {
      if (document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable.focus();
      }
    } else {
      if (document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable.focus();
      }
    }
  }
  
  modal.addEventListener('keydown', handleTab);
  return () => modal.removeEventListener('keydown', handleTab);
}

/**
 * Create and show a modal
 */
export function showModal(options = {}) {
  const {
    title = '',
    content = '',
    onClose = null,
    closeOnBackdrop = true,
    closeOnEscape = true,
    ariaLabel = title || 'Dialog'
  } = options;
  
  // Close existing modal
  if (activeModal) {
    closeModal();
  }
  
  // Create modal structure
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop fixed inset-0';
  backdrop.style.cssText = `backdrop-filter: blur(4px); background: rgba(0, 0, 0, 0.1); z-index: var(--z-modal);`;
  backdrop.setAttribute('aria-hidden', 'true');
  
  const modal = document.createElement('div');
  modal.className = 'modal-container fixed inset-0 flex items-center justify-center p-4';
  modal.style.cssText = `z-index: var(--z-modal);`;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'modal-title');
  
  const dialog = document.createElement('div');
  dialog.className = 'bg-gradient-to-br from-slate-900 to-slate-800 border-2 border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col backdrop-blur-sm';
  
  // Header
  const header = document.createElement('div');
  header.className = 'flex items-center justify-between p-4 border-b-2 border-slate-700';
  
  const titleEl = document.createElement('h3');
  titleEl.id = 'modal-title';
  titleEl.className = 'text-lg font-semibold text-slate-100';
  titleEl.textContent = title;
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-slate-400 hover:text-slate-100 transition-colors';
  closeBtn.setAttribute('aria-label', 'Close dialog');
  closeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  closeBtn.onclick = () => closeModal();
  
  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  
  // Body
  const body = document.createElement('div');
  body.className = 'p-4 overflow-y-auto flex-1';
  if (typeof content === 'string') {
    body.innerHTML = content;
  } else {
    body.appendChild(content);
  }
  
  // Assemble
  dialog.appendChild(header);
  dialog.appendChild(body);
  modal.appendChild(dialog);
  
  // Add to DOM via portal root
  createPortal(backdrop);
  createPortal(modal);
  
  // Lock scroll
  document.body.classList.add('overflow-hidden');
  
  // Focus management
  const firstFocusable = modal.querySelector(focusableElements);
  if (firstFocusable) {
    firstFocusable.focus();
  } else {
    closeBtn.focus();
  }
  
  // Event handlers
  const removeFocusTrap = trapFocus(modal);
  
  function handleEscape(e) {
    if (e.key === 'Escape' && closeOnEscape) {
      closeModal();
    }
  }
  
  function handleBackdrop(e) {
    if (e.target === backdrop && closeOnBackdrop) {
      closeModal();
    }
  }
  
  backdrop.addEventListener('click', handleBackdrop);
  document.addEventListener('keydown', handleEscape);
  
  // Store cleanup
  activeModal = {
    backdrop,
    modal,
    removeFocusTrap,
    handleEscape,
    handleBackdrop,
    onClose
  };
  
  return modal;
}

/**
 * Close active modal
 */
export function closeModal() {
  if (!activeModal) return;
  
  const { backdrop, modal, removeFocusTrap, handleEscape, handleBackdrop, onClose } = activeModal;
  
  // Cleanup
  removeFocusTrap();
  backdrop.removeEventListener('click', handleBackdrop);
  document.removeEventListener('keydown', handleEscape);
  
  // Remove from DOM via portal
  removeFromPortal(backdrop);
  removeFromPortal(modal);
  
  // Unlock scroll
  document.body.classList.remove('overflow-hidden');
  
  // Callback
  if (onClose) {
    onClose();
  }
  
  activeModal = null;
}

/**
 * Show confirmation dialog
 */
export function showConfirm(options = {}) {
  const {
    title = 'Confirm',
    message = 'Are you sure?',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    onConfirm = null,
    onCancel = null
  } = options;
  
  const content = document.createElement('div');
  content.className = 'space-y-4';
  
  const messageEl = document.createElement('p');
  messageEl.className = 'text-slate-200';
  messageEl.textContent = message;
  content.appendChild(messageEl);
  
  const actions = document.createElement('div');
  actions.className = 'flex gap-3 justify-end mt-6';
  
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg font-medium transition-all duration-200 hover:scale-105 active:scale-95';
  cancelBtn.textContent = cancelText;
  cancelBtn.onclick = () => {
    closeModal();
    if (onCancel) onCancel();
  };
  
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'px-4 py-2 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white rounded-lg font-semibold transition-all duration-200 shadow-lg hover:shadow-xl hover:scale-105 active:scale-95';
  confirmBtn.textContent = confirmText;
  confirmBtn.onclick = () => {
    closeModal();
    if (onConfirm) onConfirm();
  };
  
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  content.appendChild(actions);
  
  return showModal({
    title,
    content,
    closeOnBackdrop: false
  });
}

