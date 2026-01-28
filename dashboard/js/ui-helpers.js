// UI Helper utilities for tooltips and modals
import { createPortal, removeFromPortal } from './portal.js';

/**
 * Create and show a tooltip
 */
export function showTooltip(element, text, position = 'top') {
  const tooltip = document.createElement('div');
  tooltip.className = 'custom-tooltip';
  tooltip.textContent = text;
  tooltip.style.cssText = `
    position: fixed;
    background: #1e293b;
    color: #e2e8f0;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 0.8em;
    border: 1px solid #334155;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    z-index: var(--z-tooltip);
    pointer-events: none;
    max-width: 350px;
    word-wrap: break-word;
    white-space: normal;
    line-height: 1.4;
  `;
  
  // Render in portal root instead of document.body
  createPortal(tooltip);
  
  // Force layout calculation
  tooltip.offsetHeight;
  
  const rect = element.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  let top, left;
  
  switch (position) {
    case 'top':
      top = rect.top - tooltipRect.height - 8;
      left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
      break;
    case 'bottom':
      top = rect.bottom + 8;
      left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
      break;
    case 'left':
      top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
      left = rect.left - tooltipRect.width - 8;
      break;
    case 'right':
      top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
      left = rect.right + 8;
      break;
    default:
      top = rect.top - tooltipRect.height - 8;
      left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
  }
  
  // If tooltip would go above viewport, flip to bottom
  if (top < 8) {
    top = rect.bottom + 8;
  }
  
  // Keep tooltip within viewport
  top = Math.max(8, Math.min(top, window.innerHeight - tooltipRect.height - 8));
  left = Math.max(8, Math.min(left, window.innerWidth - tooltipRect.width - 8));
  
  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
  
  return tooltip;
}

/**
 * Remove a tooltip
 */
export function hideTooltip(tooltip) {
  removeFromPortal(tooltip);
}

/**
 * Create a modal dialog
 */
export function createModal(title, content, options = {}) {
  const {
    width = '600px',
    height = 'auto',
    closable = true,
    onClose = null,
  } = options;
  
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: var(--z-modal);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  `;
  
  const modal = document.createElement('div');
  modal.className = 'custom-modal';
  modal.style.cssText = `
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 8px;
    width: ${width};
    max-width: 90vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
  `;
  
  const header = document.createElement('div');
  header.style.cssText = `
    padding: 15px 20px;
    border-bottom: 1px solid #334155;
    display: flex;
    justify-content: space-between;
    align-items: center;
  `;
  
  const titleEl = document.createElement('h3');
  titleEl.textContent = title;
  titleEl.style.cssText = `
    margin: 0;
    color: #e2e8f0;
    font-size: 1.2em;
  `;
  
  header.appendChild(titleEl);
  
  if (closable) {
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.style.cssText = `
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 24px;
      cursor: pointer;
      padding: 0;
      width: 30px;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: all 0.2s;
    `;
    closeBtn.onmouseover = () => {
      closeBtn.style.background = '#334155';
      closeBtn.style.color = '#e2e8f0';
    };
    closeBtn.onmouseout = () => {
      closeBtn.style.background = 'transparent';
      closeBtn.style.color = '#94a3b8';
    };
    closeBtn.onclick = () => {
      if (onClose) onClose();
      removeFromPortal(overlay);
    };
    header.appendChild(closeBtn);
  }
  
  const body = document.createElement('div');
  body.style.cssText = `
    padding: 20px;
    overflow-y: auto;
    flex: 1;
    color: #e2e8f0;
  `;
  body.innerHTML = content;
  
  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  
  // Close on overlay click
  overlay.onclick = (e) => {
    if (e.target === overlay && closable) {
      if (onClose) onClose();
      removeFromPortal(overlay);
    }
  };
  
  // Close on Escape key
  const escapeHandler = (e) => {
    if (e.key === 'Escape' && closable) {
      if (onClose) onClose();
      removeFromPortal(overlay);
      document.removeEventListener('keydown', escapeHandler);
    }
  };
  document.addEventListener('keydown', escapeHandler);
  
  // Render in portal root instead of document.body
  createPortal(overlay);
  
  return { overlay, modal, body };
}

/**
 * Add tooltip to an element on hover
 */
export function addTooltip(element, text, position = 'top') {
  let tooltip = null;
  
  element.onmouseenter = (e) => {
    tooltip = showTooltip(element, text, position);
  };
  
  element.onmouseleave = () => {
    if (tooltip) {
      hideTooltip(tooltip);
      tooltip = null;
    }
  };
  
  return () => {
    if (tooltip) {
      hideTooltip(tooltip);
      tooltip = null;
    }
  };
}

