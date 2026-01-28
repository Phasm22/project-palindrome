/**
 * Reusable UI Components
 * Centralized component library for consistent styling across the dashboard
 */

import { createIcon, createIconWithText } from './icons.js';

/**
 * Create a logo image element (reusable component)
 */
export function createLogo(options = {}) {
  const {
    size = 18, // Size in pixels
    className = '',
    style = {},
    animate = false, // Whether to add animation classes
    spinOnClick = false // Whether to spin on click
  } = options;
  
  const logo = document.createElement('img');
  logo.src = 'assets/images/logo.png';
  logo.alt = 'Palindrome Logo';
  logo.className = `object-contain ${className}`;
  // Don't set filter in inline style - let CSS handle it for refresh buttons
  const inlineStyle = Object.entries(style).map(([k, v]) => `${k}: ${v}`).join('; ');
  logo.style.cssText = `
    width: ${size}px;
    height: ${size}px;
    ${inlineStyle ? inlineStyle + ';' : ''}
  `;
  
  // Add animation class if requested
  if (animate) {
    logo.classList.add('logo-animated');
  }
  
  // Add spin on click if requested
  if (spinOnClick) {
    logo.classList.add('logo-spin-on-click');
  }
  
  // Handle error - fallback to icon
  logo.addEventListener('error', () => {
    console.warn('Logo not found, using fallback');
    const icon = createIcon('RefreshCw', { size, color: 'currentColor' });
    logo.replaceWith(icon);
  });
  
  return logo;
}

/**
 * Button component - consistent styling for all buttons with enhanced effects
 */
export function createButton(text, options = {}) {
  const {
    variant = 'primary', // 'primary', 'secondary', 'danger', 'ghost'
    size = 'md', // 'sm', 'md', 'lg'
    onClick = null,
    disabled = false,
    className = '',
    icon = null,
    iconName = null, // Use iconName for Lucide icons
    type = 'button'
  } = options;

  const baseClasses = 'relative font-semibold transition-all duration-200 cursor-pointer rounded-xl border overflow-hidden';
  const sizeClasses = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-6 py-3 text-base',
    lg: 'px-8 py-4 text-lg'
  };
  const variantClasses = {
    primary: 'bg-gradient-to-r from-primary-500 to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white border-primary-600 hover:border-primary-700 shadow-lg shadow-primary-500/50 hover:shadow-xl hover:shadow-primary-500/70 hover:scale-105 active:scale-95',
    secondary: 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-600 hover:border-slate-500 shadow-lg hover:shadow-xl hover:scale-105 active:scale-95',
    danger: 'bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white border-red-600 hover:border-red-700 shadow-lg shadow-red-600/50 hover:shadow-xl hover:shadow-red-600/70 hover:scale-105 active:scale-95',
    ghost: 'bg-transparent hover:bg-slate-800 text-slate-300 hover:text-slate-200 border-transparent hover:border-slate-600'
  };

  const classes = `${baseClasses} ${sizeClasses[size]} ${variantClasses[variant]} ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className}`;

  const button = document.createElement('button');
  button.type = type;
  button.className = classes;
  
  // Add shimmer overlay for primary buttons
  if (variant === 'primary' && !disabled) {
    const shimmer = document.createElement('span');
    shimmer.className = 'absolute inset-0 bg-white/10 opacity-0 hover:opacity-100 transition-opacity duration-200 rounded-xl';
    button.appendChild(shimmer);
  }
  
  const content = document.createElement('span');
  content.className = 'relative z-10 flex items-center justify-center gap-2';
  
  if (iconName) {
    const iconEl = createIcon(iconName, { size: size === 'sm' ? 16 : size === 'lg' ? 24 : 20 });
    content.appendChild(iconEl);
  } else if (icon) {
    const iconEl = document.createElement('span');
    iconEl.innerHTML = icon;
    iconEl.className = 'inline-block';
    content.appendChild(iconEl);
  }
  
  if (text) {
    const textEl = document.createElement('span');
    textEl.textContent = text;
    content.appendChild(textEl);
  }
  
  button.appendChild(content);
  
  if (disabled) button.disabled = true;
  if (onClick) button.addEventListener('click', onClick);

  return button;
}

/**
 * Card component - consistent card styling with elevation and hover effects
 */
export function createCard(content, options = {}) {
  const {
    padding = 'p-6',
    className = '',
    header = null,
    footer = null,
    elevated = true
  } = options;

  const card = document.createElement('div');
  const baseClasses = `group relative bg-gradient-to-br from-slate-900 to-slate-800 border-2 border-slate-700 rounded-2xl ${padding}`;
  const elevatedClasses = elevated ? 'card-elevated' : '';
  card.className = `${baseClasses} ${elevatedClasses} ${className}`;

  const contentWrapper = document.createElement('div');
  contentWrapper.className = 'relative z-10';

  if (header) {
    const headerEl = document.createElement('div');
    headerEl.className = 'mb-4 pb-3 border-b border-slate-700';
    if (typeof header === 'string') {
      headerEl.textContent = header;
      headerEl.className += ' text-slate-200 font-semibold text-lg';
    } else {
      headerEl.appendChild(header);
    }
    contentWrapper.appendChild(headerEl);
  }

  if (typeof content === 'string') {
    const contentDiv = document.createElement('div');
    contentDiv.innerHTML = content;
    contentWrapper.appendChild(contentDiv);
  } else if (content instanceof Node) {
    contentWrapper.appendChild(content);
  } else {
    contentWrapper.appendChild(content);
  }

  if (footer) {
    const footerEl = document.createElement('div');
    footerEl.className = 'mt-4 pt-3 border-t border-slate-700';
    if (typeof footer === 'string') {
      footerEl.textContent = footer;
    } else {
      footerEl.appendChild(footer);
    }
    contentWrapper.appendChild(footerEl);
  }

  card.appendChild(contentWrapper);

  return card;
}

/**
 * Create a skeleton loading card
 */
export function createSkeletonCard(options = {}) {
  const { lines = 3, className = '' } = options;
  const card = document.createElement('div');
  card.className = `bg-gradient-to-br from-slate-900 to-slate-800 border-2 border-slate-700 rounded-2xl p-6 ${className}`;
  
  const skeletonLines = Array.from({ length: lines }, (_, i) => {
    const line = document.createElement('div');
    line.className = `h-4 skeleton rounded-lg mb-3 ${i === 0 ? 'w-3/4' : i === lines - 1 ? 'w-1/2' : 'w-full'}`;
    return line;
  });
  
  skeletonLines.forEach(line => card.appendChild(line));
  return card;
}

/**
 * Create a skeleton spinner
 */
export function createSkeletonSpinner(options = {}) {
  const { size = 48, className = '' } = options;
  const container = document.createElement('div');
  container.className = `relative flex items-center justify-center ${className}`;
  container.style.width = `${size}px`;
  container.style.height = `${size}px`;
  
  const spinner = document.createElement('div');
  spinner.className = 'absolute inset-0 border-2 border-slate-700 border-t-primary-500 rounded-full';
  container.appendChild(spinner);
  
  return container;
}

/**
 * Conversation item component - consistent styling for conversation list items
 */
export function createConversationItem(conversation, options = {}) {
  const {
    isActive = false,
    onSelect = null,
    onDelete = null
  } = options;

  const item = document.createElement('div');
  item.className = `flex items-center justify-between p-3 rounded-xl cursor-pointer transition-colors group ${
    isActive 
      ? 'bg-slate-800/80 border border-primary-500/30 text-primary-400' 
      : 'bg-slate-800/60 hover:bg-slate-800/80 border border-slate-700/50 text-slate-200'
  }`;

  const content = document.createElement('div');
  content.className = 'flex-1 min-w-0';
  
  const title = document.createElement('div');
  title.className = 'font-medium text-sm truncate';
  title.textContent = conversation.title || 'New Conversation';
  content.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'text-xs text-slate-400 mt-1';
  meta.textContent = `${conversation.messageCount || 0} message${conversation.messageCount !== 1 ? 's' : ''}`;
  content.appendChild(meta);

  item.appendChild(content);

  if (onDelete) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity flex-shrink-0 p-1.5 rounded-lg bg-transparent border-none text-slate-400 hover:text-red-400 cursor-pointer';
    deleteBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
      </svg>
    `;
    deleteBtn.title = 'Delete conversation';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete(conversation.id);
    });
    item.appendChild(deleteBtn);
  }

  if (onSelect) {
    item.addEventListener('click', () => onSelect(conversation.id));
  }

  return item;
}

/**
 * Input component - consistent input styling
 */
export function createInput(options = {}) {
  const {
    type = 'text',
    placeholder = '',
    value = '',
    className = '',
    size = 'md'
  } = options;

  const sizeClasses = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-base',
    lg: 'px-5 py-3 text-lg'
  };

  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.className = `w-full ${sizeClasses[size]} bg-slate-800 border border-slate-600 rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent ${className}`;

  return input;
}

/**
 * Container component - consistent max-width and padding
 */
export function createContainer(content, options = {}) {
  const {
    maxWidth = 'max-w-7xl', // 'max-w-4xl', 'max-w-5xl', 'max-w-6xl', 'max-w-7xl'
    className = '',
    padding = 'px-6'
  } = options;

  const container = document.createElement('div');
  container.className = `mx-auto ${maxWidth} ${padding} ${className}`;

  if (typeof content === 'string') {
    container.innerHTML = content;
  } else if (content instanceof Node) {
    container.appendChild(content);
  } else if (Array.isArray(content)) {
    content.forEach(item => container.appendChild(item));
  }

  return container;
}

/**
 * Section component - consistent section styling
 */
export function createSection(title, content, options = {}) {
  const {
    className = '',
    titleClassName = ''
  } = options;

  const section = document.createElement('section');
  section.className = `mb-6 ${className}`;

  if (title) {
    const titleEl = document.createElement('h2');
    titleEl.className = `text-xl font-semibold mb-4 text-slate-200 ${titleClassName}`;
    titleEl.textContent = title;
    section.appendChild(titleEl);
  }

  if (typeof content === 'string') {
    section.innerHTML += content;
  } else if (content instanceof Node) {
    section.appendChild(content);
  }

  return section;
}

/**
 * Badge component - consistent badge styling with gradients and pulse
 */
export function createBadge(text, options = {}) {
  const {
    variant = 'default', // 'default', 'success', 'warning', 'error', 'info'
    size = 'sm',
    pulse = false,
    icon = null
  } = options;

  const sizeClasses = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-3 py-1.5 text-sm'
  };

  const variantClasses = {
    default: 'bg-gradient-to-r from-slate-800 to-slate-700 text-slate-300 border-slate-600 shadow-lg',
    success: 'bg-gradient-to-r from-green-500 to-emerald-500 text-white border-green-600 shadow-lg shadow-green-500/50',
    warning: 'bg-gradient-to-r from-yellow-500 to-amber-500 text-white border-yellow-600 shadow-lg shadow-yellow-500/50',
    error: 'bg-gradient-to-r from-red-500 to-red-600 text-white border-red-600 shadow-lg shadow-red-500/50',
    info: 'bg-gradient-to-r from-blue-500 to-cyan-500 text-white border-blue-600 shadow-lg shadow-blue-500/50'
  };

  const badge = document.createElement('span');
  const pulseClass = pulse ? 'status-badge-pulse animate-pulse-glow' : '';
  badge.className = `inline-flex items-center gap-1.5 font-medium rounded-full border ${sizeClasses[size]} ${variantClasses[variant]} ${pulseClass}`;
  
  if (pulse) {
    const dot = document.createElement('span');
    dot.className = 'w-2 h-2 bg-white rounded-full animate-pulse';
    badge.appendChild(dot);
  }
  
  if (icon) {
    const iconEl = typeof icon === 'string' ? createIcon(icon, { size: size === 'sm' ? 12 : 16 }) : icon;
    badge.appendChild(iconEl);
  }
  
  const textEl = document.createElement('span');
  textEl.textContent = text;
  badge.appendChild(textEl);

  return badge;
}

