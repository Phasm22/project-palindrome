/**
 * LayoutStore - Centralized state management for layout UI
 * Note: Route/navigation state is NOT stored here - it's derived from URL
 */

class LayoutStore {
  constructor() {
    this.state = {
      // Sidebar state
      sidebarOpen: false,
      sidebarCollapsed: false,
      sidebarWidth: 256,
      
      // Mobile state
      isMobile: window.innerWidth < 768,
      mobileMenuOpen: false,
      
      // UI state
      theme: 'dark', // 'light' | 'dark'
      
      // Content loading state
      contentLoading: false
    };
    
    this.listeners = new Set();
    
    // Listen for window resize to update mobile state
    this.handleResize = this.handleResize.bind(this);
    window.addEventListener('resize', this.handleResize);
    
    // Load persisted state from localStorage
    this.loadPersistedState();
  }
  
  /**
   * Get current state
   */
  getState() {
    return { ...this.state };
  }
  
  /**
   * Subscribe to state changes
   * @param {Function} listener - Callback function
   * @returns {Function} Unsubscribe function
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  
  /**
   * Update state and notify listeners
   * @param {Partial<LayoutState>} updates - State updates
   */
  updateState(updates) {
    this.state = { ...this.state, ...updates };
    this.listeners.forEach(listener => listener(this.state));
    
    // Persist certain state to localStorage
    this.persistState();
  }
  
  /**
   * Handle window resize - update mobile state
   */
  handleResize() {
    const isMobile = window.innerWidth < 768;
    if (isMobile !== this.state.isMobile) {
      this.updateState({ isMobile });
      
      // Close sidebar on mobile if it was open on desktop
      if (isMobile && this.state.sidebarOpen) {
        this.updateState({ sidebarOpen: false });
      }
    }
  }
  
  /**
   * Load persisted state from localStorage
   */
  loadPersistedState() {
    try {
      const persisted = localStorage.getItem('layout-state');
      if (persisted) {
        const parsed = JSON.parse(persisted);
        // Only restore safe, non-sensitive state
        if (parsed.theme) {
          this.state.theme = parsed.theme;
        }
        if (parsed.sidebarCollapsed !== undefined) {
          this.state.sidebarCollapsed = parsed.sidebarCollapsed;
        }
        if (parsed.sidebarWidth) {
          this.state.sidebarWidth = parsed.sidebarWidth;
        }
      }
    } catch (e) {
      console.warn('Failed to load persisted layout state:', e);
    }
  }
  
  /**
   * Persist state to localStorage
   */
  persistState() {
    try {
      const toPersist = {
        theme: this.state.theme,
        sidebarCollapsed: this.state.sidebarCollapsed,
        sidebarWidth: this.state.sidebarWidth
      };
      localStorage.setItem('layout-state', JSON.stringify(toPersist));
    } catch (e) {
      console.warn('Failed to persist layout state:', e);
    }
  }
  
  /**
   * Toggle sidebar
   */
  toggleSidebar() {
    this.updateState({ sidebarOpen: !this.state.sidebarOpen });
  }
  
  /**
   * Set sidebar open state
   */
  setSidebarOpen(open) {
    this.updateState({ sidebarOpen: open });
  }
  
  /**
   * Toggle sidebar collapsed state
   */
  toggleSidebarCollapsed() {
    this.updateState({ sidebarCollapsed: !this.state.sidebarCollapsed });
  }
  
  /**
   * Set theme
   */
  setTheme(theme) {
    this.updateState({ theme });
  }
  
  /**
   * Toggle mobile menu
   */
  toggleMobileMenu() {
    this.updateState({ mobileMenuOpen: !this.state.mobileMenuOpen });
  }
  
  /**
   * Set content loading state
   */
  setContentLoading(loading) {
    this.updateState({ contentLoading: loading });
  }
}

// Singleton instance
export const layoutStore = new LayoutStore();
