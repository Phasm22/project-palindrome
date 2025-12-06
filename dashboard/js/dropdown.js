// Custom dropdown component for mobile tab navigation

const tabs = [
  { id: 'chat', label: 'Chat' },
  { id: 'overview', label: 'Overview' },
  { id: 'executions', label: 'Tool Executions' },
  { id: 'reasoning', label: 'Reasoning Traces' },
  { id: 'graph', label: 'Ontology Graph' },
  { id: 'rag', label: 'RAG Diagnostics' },
  { id: 'query', label: 'Query' }
];

let currentDropdown = null;
let isOpen = false;

export function createCustomDropdown(containerId, currentTab = 'chat') {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  // Remove existing dropdown if any
  if (currentDropdown) {
    currentDropdown.remove();
  }
  
  // Create dropdown button
  const button = document.createElement('button');
  button.className = 'w-full px-4 py-3 bg-slate-900 border-2 border-slate-600 rounded-xl text-slate-200 text-base font-medium focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2';
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  
  const currentTabData = tabs.find(t => t.id === currentTab) || tabs[0];
  button.innerHTML = `
    <span>${currentTabData.label}</span>
    <svg class="w-5 h-5 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
    </svg>
  `;
  
  // Create dropdown menu
  const menu = document.createElement('div');
  menu.className = 'absolute top-full left-0 right-0 mt-2 bg-slate-900 border-2 border-slate-600 rounded-xl shadow-xl z-50 max-h-[70vh] overflow-y-auto hidden';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-orientation', 'vertical');
  
  // Create menu items
  tabs.forEach(tab => {
    const item = document.createElement('button');
    item.className = `w-full px-4 py-3 text-left text-slate-200 hover:bg-slate-800 hover:text-primary-400 transition-colors flex items-center gap-3 ${tab.id === currentTab ? 'bg-slate-800 text-primary-500' : ''}`;
    item.setAttribute('role', 'menuitem');
    item.textContent = tab.label;
    
    if (tab.id === currentTab) {
      const checkIcon = document.createElement('svg');
      checkIcon.className = 'w-5 h-5 text-primary-500 flex-shrink-0';
      checkIcon.setAttribute('fill', 'none');
      checkIcon.setAttribute('stroke', 'currentColor');
      checkIcon.setAttribute('viewBox', '0 0 24 24');
      checkIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>';
      item.insertBefore(checkIcon, item.firstChild);
    }
    
    item.onclick = (e) => {
      e.stopPropagation();
      window.switchTabMobile(tab.id);
      closeDropdown();
    };
    
    menu.appendChild(item);
  });
  
  // Create wrapper with relative positioning
  const wrapper = document.createElement('div');
  wrapper.className = 'relative';
  wrapper.appendChild(button);
  wrapper.appendChild(menu);
  
  // Toggle dropdown
  button.onclick = (e) => {
    e.stopPropagation();
    if (isOpen) {
      closeDropdown();
    } else {
      openDropdown(button, menu);
    }
  };
  
  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) {
      closeDropdown();
    }
  });
  
  // Close on escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      closeDropdown();
      button.focus();
    }
  });
  
  container.appendChild(wrapper);
  currentDropdown = wrapper;
  
  function openDropdown(btn, mnu) {
    mnu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    btn.querySelector('svg').classList.add('rotate-180');
    isOpen = true;
  }
  
  function closeDropdown() {
    if (menu) {
      menu.classList.add('hidden');
      button.setAttribute('aria-expanded', 'false');
      button.querySelector('svg').classList.remove('rotate-180');
      isOpen = false;
    }
  }
  
  return wrapper;
}

export function updateDropdown(currentTab) {
  if (currentDropdown) {
    const button = currentDropdown.querySelector('button');
    const currentTabData = tabs.find(t => t.id === currentTab) || tabs[0];
    button.innerHTML = `
      <span>${currentTabData.label}</span>
      <svg class="w-5 h-5 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
      </svg>
    `;
    
    // Update active state in menu
    const menu = currentDropdown.querySelector('[role="menu"]');
    if (menu) {
      Array.from(menu.children).forEach((item, idx) => {
        const tab = tabs[idx];
        if (tab.id === currentTab) {
          item.className = item.className.replace(/bg-slate-\d+|text-slate-\d+|text-primary-\d+/, '') + ' bg-slate-800 text-primary-500';
          if (!item.querySelector('svg')) {
            const checkIcon = document.createElement('svg');
            checkIcon.className = 'w-5 h-5 text-primary-500 flex-shrink-0';
            checkIcon.setAttribute('fill', 'none');
            checkIcon.setAttribute('stroke', 'currentColor');
            checkIcon.setAttribute('viewBox', '0 0 24 24');
            checkIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>';
            item.insertBefore(checkIcon, item.firstChild);
          }
        } else {
          item.className = item.className.replace(/bg-slate-\d+|text-slate-\d+|text-primary-\d+/, '') + ' text-slate-200';
          const checkIcon = item.querySelector('svg');
          if (checkIcon) checkIcon.remove();
        }
      });
    }
  }
}

