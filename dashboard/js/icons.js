/**
 * Icon utilities using Lucide icons
 * Provides consistent icon rendering with animations
 */

// Import Lucide icons - we'll use a CDN approach for vanilla JS
// Since we're using vanilla JS, we'll create SVG elements based on Lucide icon paths

const iconPaths = {
  Clock: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  BarChart3: 'M3 3v18h18M7 16l4-4 4 4 6-6',
  Heart: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
  Server: 'M4 4h16v4H4V4zm2 4v12h12V8H6zm4 7h4v-4h-4v4z',
  Plus: 'M12 5v14m7-7H5',
  Menu: 'M3 12h18M3 6h18M3 18h18',
  X: 'M18 6L6 18M6 6l12 12',
  RefreshCw: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 8v6m0-6h-6m5.99 4.99A9 9 0 0 1 12 21a9.75 9.75 0 0 1-6.74-2.74L3 16M3 16v-6m0 6h6',
  Search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
  ZoomIn: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7',
  ZoomOut: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7',
  Maximize: 'M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3',
  RotateCcw: 'M1 4v6h6M3.51 15a9 9 0 102.13-9.36L1 10',
  Send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  MessageSquare: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',
  Trash2: 'M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2',
  Activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  Database: 'M4 7c0-1.1.9-2 2-2h12c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V7zm8 0v10m-4-5h8',
  Network: 'M16 3h5v5M8 21H3v-5M3 8l5 5M21 16l-5-5',
  Settings: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z',
  ChevronRight: 'M9 18l6-6-6-6',
  Info: 'M12 16v-4m0-4h.01M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10z',
  AlertCircle: 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  CheckCircle: 'M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3',
  XCircle: 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z',
};

/**
 * Create an icon SVG element
 * @param {string} iconName - Name of the icon
 * @param {object} options - Icon options
 * @returns {SVGElement}
 */
export function createIcon(iconName, options = {}) {
  const {
    size = 24,
    color = 'currentColor',
    className = '',
    animation = null, // 'pulse', 'rotate', 'bounce', 'heartbeat'
    strokeWidth = 2,
  } = options;

  const path = iconPaths[iconName];
  if (!path) {
    console.warn(`Icon "${iconName}" not found`);
    return document.createElement('span');
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', color);
  svg.setAttribute('stroke-width', strokeWidth);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  
  if (className) {
    svg.classList.add(...className.split(' '));
  }
  
  // Add animation class
  if (animation) {
    switch (animation) {
      case 'pulse':
        svg.classList.add('icon-pulse');
        break;
      case 'rotate':
      case 'bounce':
      case 'heartbeat':
        // Animations removed - keeping icons simple
        break;
    }
  }

  const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathEl.setAttribute('d', path);
  svg.appendChild(pathEl);

  return svg;
}

/**
 * Create an icon with text (for buttons, etc.)
 */
export function createIconWithText(iconName, text, options = {}) {
  const container = document.createElement('span');
  container.className = 'inline-flex items-center gap-2';
  
  const icon = createIcon(iconName, options);
  container.appendChild(icon);
  
  if (text) {
    const textEl = document.createElement('span');
    textEl.textContent = text;
    container.appendChild(textEl);
  }
  
  return container;
}

