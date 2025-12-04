/**
 * Reusable UI Components
 * Centralized component library for consistent styling across the dashboard
 */

/**
 * Button component - consistent styling for all buttons
 */
export function createButton(text, options = {}) {
  const {
    variant = 'primary', // 'primary', 'secondary', 'danger', 'ghost'
    size = 'md', // 'sm', 'md', 'lg'
    onClick = null,
    disabled = false,
    className = '',
    icon = null,
    type = 'button'
  } = options;

  const baseClasses = 'font-medium transition-colors cursor-pointer rounded-lg border';
  const sizeClasses = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-base',
    lg: 'px-6 py-3 text-lg'
  };
  const variantClasses = {
    primary: 'bg-primary-600 hover:bg-primary-700 text-white border-primary-600 hover:border-primary-700',
    secondary: 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-600 hover:border-slate-500',
    danger: 'bg-red-600 hover:bg-red-700 text-white border-red-600 hover:border-red-700',
    ghost: 'bg-transparent hover:bg-slate-800 text-slate-300 hover:text-slate-200 border-transparent hover:border-slate-600'
  };

  const classes = `${baseClasses} ${sizeClasses[size]} ${variantClasses[variant]} ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className}`;

  const button = document.createElement('button');
  button.type = type;
  button.className = classes;
  button.textContent = text;
  if (disabled) button.disabled = true;
  if (onClick) button.addEventListener('click', onClick);

  if (icon) {
    const iconEl = document.createElement('span');
    iconEl.innerHTML = icon;
    iconEl.className = 'inline-block mr-2';
    button.insertBefore(iconEl, button.firstChild);
  }

  return button;
}

/**
 * Card component - consistent card styling
 */
export function createCard(content, options = {}) {
  const {
    padding = 'p-4',
    className = '',
    header = null,
    footer = null
  } = options;

  const card = document.createElement('div');
  card.className = `bg-slate-950 border border-slate-700 rounded-lg ${padding} ${className}`;

  if (header) {
    const headerEl = document.createElement('div');
    headerEl.className = 'mb-4 pb-3 border-b border-slate-700';
    if (typeof header === 'string') {
      headerEl.textContent = header;
      headerEl.className += ' text-slate-200 font-semibold text-base';
    } else {
      headerEl.appendChild(header);
    }
    card.appendChild(headerEl);
  }

  if (typeof content === 'string') {
    card.innerHTML = content;
  } else if (content instanceof Node) {
    card.appendChild(content);
  } else {
    card.appendChild(content);
  }

  if (footer) {
    const footerEl = document.createElement('div');
    footerEl.className = 'mt-4 pt-3 border-t border-slate-700';
    if (typeof footer === 'string') {
      footerEl.textContent = footer;
    } else {
      footerEl.appendChild(footer);
    }
    card.appendChild(footerEl);
  }

  return card;
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
  item.className = `flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors mb-2 ${
    isActive 
      ? 'bg-primary-600/20 border border-primary-500/50 text-primary-500' 
      : 'bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200'
  }`;
  item.style.borderRadius = '0.5rem'; // Consistent rounded-lg

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
    item.className += ' group'; // Add group class for hover effects
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
 * Badge component - consistent badge styling
 */
export function createBadge(text, options = {}) {
  const {
    variant = 'default', // 'default', 'success', 'warning', 'error', 'info'
    size = 'sm'
  } = options;

  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-2.5 py-1 text-sm'
  };

  const variantClasses = {
    default: 'bg-slate-800 text-slate-300 border-slate-600',
    success: 'bg-green-900/30 text-green-400 border-green-700',
    warning: 'bg-yellow-900/30 text-yellow-400 border-yellow-700',
    error: 'bg-red-900/30 text-red-400 border-red-700',
    info: 'bg-blue-900/30 text-blue-400 border-blue-700'
  };

  const badge = document.createElement('span');
  badge.className = `inline-flex items-center font-medium rounded border ${sizeClasses[size]} ${variantClasses[variant]}`;
  badge.textContent = text;

  return badge;
}

