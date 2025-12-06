/**
 * Skeleton loading components
 * Replace "Loading..." text with animated skeleton screens
 */

/**
 * Create a skeleton stat card
 */
export function createSkeletonStatCard() {
  const card = document.createElement('div');
  card.className = 'stat-card card-elevated animate-slide-up';
  
  const label = document.createElement('div');
  label.className = 'stat-label skeleton h-4 w-24 rounded mb-3';
  card.appendChild(label);
  
  const value = document.createElement('div');
  value.className = 'stat-value skeleton h-8 w-16 rounded';
  card.appendChild(value);
  
  return card;
}

/**
 * Create skeleton grid for stats
 */
export function createSkeletonStatsGrid(count = 3) {
  const container = document.createElement('div');
  container.className = 'status-grid';
  
  for (let i = 0; i < count; i++) {
    const card = createSkeletonStatCard();
    card.style.animationDelay = `${i * 0.1}s`;
    container.appendChild(card);
  }
  
  return container;
}

/**
 * Create skeleton table rows
 */
export function createSkeletonTableRows(count = 5) {
  const container = document.createElement('div');
  
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'flex gap-4 p-4 border-b border-slate-700 animate-slide-up';
    row.style.animationDelay = `${i * 0.05}s`;
    
    for (let j = 0; j < 4; j++) {
      const cell = document.createElement('div');
      cell.className = 'skeleton h-4 rounded flex-1';
      if (j === 0) cell.style.width = '150px';
      if (j === 3) cell.style.width = '100px';
      row.appendChild(cell);
    }
    
    container.appendChild(row);
  }
  
  return container;
}

/**
 * Create skeleton spinner with text
 */
export function createSkeletonLoader(text = 'Loading...') {
  const container = document.createElement('div');
  container.className = 'flex flex-col items-center justify-center py-10 gap-4';
  
  const spinner = document.createElement('div');
  spinner.className = 'relative w-12 h-12';
  
  const spinnerBg = document.createElement('div');
  spinnerBg.className = 'absolute inset-0 border-2 border-slate-700 rounded-full';
  spinner.appendChild(spinnerBg);
  
  const spinnerFg = document.createElement('div');
  spinnerFg.className = 'absolute inset-0 border-2 border-transparent border-t-primary-500 rounded-full';
  spinner.appendChild(spinnerFg);
  
  container.appendChild(spinner);
  
  if (text) {
    const textEl = document.createElement('div');
    textEl.className = 'text-slate-400 text-sm';
    textEl.textContent = text;
    container.appendChild(textEl);
  }
  
  return container;
}

