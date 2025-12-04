// Shared utilities
export const API_URL = "http://localhost:4000";

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

