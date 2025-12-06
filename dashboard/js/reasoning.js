import { API_URL } from './utils.js';
import { addTooltip, createModal } from './ui-helpers.js';
import { createSkeletonLoader } from './skeletons.js';

// Format tool results for readable display
function formatToolResult(dataPreview, toolName) {
  if (!dataPreview) return '';
  
  try {
    // Try to parse as JSON
    const data = typeof dataPreview === 'string' ? JSON.parse(dataPreview) : dataPreview;
    
    // Handle Proxmox VM list
    if (data.vms && Array.isArray(data.vms)) {
      return `
        <div style="font-size: 0.8rem;">
          <div style="color: #10b981; margin-bottom: 8px; font-weight: 600;">
            📦 ${data.vms.length} VM${data.vms.length !== 1 ? 's' : ''} found
          </div>
          <div style="display: grid; gap: 6px;">
            ${data.vms.slice(0, 10).map(vm => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #1e293b; border-radius: 4px;">
                <span style="width: 8px; height: 8px; border-radius: 50%; background: ${vm.status === 'running' ? '#10b981' : '#94a3b8'};"></span>
                <span style="color: #f97316; font-weight: 500; min-width: 120px;">${vm.name || vm.vmid}</span>
                <span style="color: #94a3b8; font-size: 0.75rem;">ID: ${vm.vmid}</span>
                <span style="color: #94a3b8; font-size: 0.75rem;">${vm.node || ''}</span>
                ${vm.mem_normalized ? `<span style="color: #8b5cf6; font-size: 0.75rem;">${vm.mem_normalized.value}${vm.mem_normalized.unit}</span>` : ''}
              </div>
            `).join('')}
            ${data.vms.length > 10 ? `<div style="color: #94a3b8; font-size: 0.75rem;">... and ${data.vms.length - 10} more</div>` : ''}
          </div>
        </div>
      `;
    }
    
    // Handle containers
    if (data.containers && Array.isArray(data.containers)) {
      return `
        <div style="font-size: 0.8rem;">
          <div style="color: #10b981; margin-bottom: 8px; font-weight: 600;">
            🐳 ${data.containers.length} container${data.containers.length !== 1 ? 's' : ''} found
          </div>
          <div style="display: grid; gap: 6px;">
            ${data.containers.slice(0, 10).map(ct => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #1e293b; border-radius: 4px;">
                <span style="width: 8px; height: 8px; border-radius: 50%; background: ${ct.status === 'running' ? '#10b981' : '#94a3b8'};"></span>
                <span style="color: #f97316; font-weight: 500;">${ct.name || ct.vmid}</span>
                <span style="color: #94a3b8; font-size: 0.75rem;">ID: ${ct.vmid}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
    
    // Handle nodes
    if (data.nodes && Array.isArray(data.nodes)) {
      return `
        <div style="font-size: 0.8rem;">
          <div style="color: #10b981; margin-bottom: 8px; font-weight: 600;">
            🖥️ ${data.nodes.length} node${data.nodes.length !== 1 ? 's' : ''} found
          </div>
          <div style="display: grid; gap: 6px;">
            ${data.nodes.map(node => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #1e293b; border-radius: 4px;">
                <span style="width: 8px; height: 8px; border-radius: 50%; background: ${node.status === 'online' ? '#10b981' : '#ef4444'};"></span>
                <span style="color: #f97316; font-weight: 500;">${node.node}</span>
                <span style="color: #94a3b8; font-size: 0.75rem;">${node.status}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
    
    // Handle graph/twin query results
    if (data.entities && Array.isArray(data.entities)) {
      return `
        <div style="font-size: 0.8rem;">
          <div style="color: #8b5cf6; margin-bottom: 8px; font-weight: 600;">
            🔗 ${data.entities.length} entit${data.entities.length !== 1 ? 'ies' : 'y'} found
          </div>
          <div style="display: grid; gap: 6px;">
            ${data.entities.slice(0, 8).map(e => `
              <div style="padding: 6px 8px; background: #1e293b; border-radius: 4px; display: flex; gap: 8px; align-items: center;">
                <span style="background: #8b5cf6; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.7rem;">${e.type || e.labels?.[0] || 'Entity'}</span>
                <span style="color: #e2e8f0;">${e.name || e.properties?.name || e.id || 'Unknown'}</span>
              </div>
            `).join('')}
            ${data.entities.length > 8 ? `<div style="color: #94a3b8; font-size: 0.75rem;">... and ${data.entities.length - 8} more</div>` : ''}
          </div>
        </div>
      `;
    }
    
    // Handle simple success/error responses
    if (data.success !== undefined) {
      return `
        <div style="display: flex; align-items: center; gap: 8px; color: ${data.success ? '#10b981' : '#ef4444'};">
          ${data.success ? '✅' : '❌'} ${data.message || (data.success ? 'Operation successful' : 'Operation failed')}
        </div>
      `;
    }
    
    // Default: pretty print JSON with truncation
    const jsonStr = JSON.stringify(data, null, 2);
    if (jsonStr.length > 500) {
      return `<pre style="background: #0f172a; padding: 8px; border-radius: 4px; font-size: 0.7rem; overflow-x: auto; margin: 0; max-height: 150px; overflow-y: auto;">${jsonStr.substring(0, 500)}...\n<span style="color: #94a3b8;">[${jsonStr.length - 500} more chars]</span></pre>`;
    }
    return `<pre style="background: #0f172a; padding: 8px; border-radius: 4px; font-size: 0.7rem; overflow-x: auto; margin: 0;">${jsonStr}</pre>`;
    
  } catch (e) {
    // Not JSON, show as text with truncation
    const text = String(dataPreview);
    if (text.length > 300) {
      return `<pre style="background: #0f172a; padding: 8px; border-radius: 4px; font-size: 0.75rem; overflow-x: auto; margin: 0; max-height: 100px; overflow-y: auto;">${text.substring(0, 300)}...\n<span style="color: #94a3b8;">[truncated]</span></pre>`;
    }
    return `<pre style="background: #0f172a; padding: 8px; border-radius: 4px; font-size: 0.75rem; overflow-x: auto; margin: 0;">${text}</pre>`;
  }
}

// Format markdown-like response for display
function formatFinalResponse(text) {
  if (!text) return '';
  
  // Escape HTML first
  let formatted = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  // Bold: **text**
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong style="color: #f97316;">$1</strong>');
  
  // Headers: lines starting with #
  formatted = formatted.replace(/^### (.+)$/gm, '<div style="color: #8b5cf6; font-weight: 600; margin: 12px 0 6px 0;">$1</div>');
  formatted = formatted.replace(/^## (.+)$/gm, '<div style="color: #f97316; font-weight: 600; font-size: 1.1em; margin: 14px 0 8px 0;">$1</div>');
  formatted = formatted.replace(/^# (.+)$/gm, '<div style="color: #10b981; font-weight: 700; font-size: 1.2em; margin: 16px 0 10px 0;">$1</div>');
  
  // List items: - item or * item or numbered 1. item
  formatted = formatted.replace(/^(\d+)\. (.+)$/gm, '<div style="margin: 4px 0 4px 16px;"><span style="color: #f97316; margin-right: 8px;">$1.</span>$2</div>');
  formatted = formatted.replace(/^[\-\*] (.+)$/gm, '<div style="margin: 4px 0 4px 16px;"><span style="color: #10b981; margin-right: 8px;">•</span>$1</div>');
  
  // Indented sub-items
  formatted = formatted.replace(/^   [\-\*] (.+)$/gm, '<div style="margin: 2px 0 2px 32px; font-size: 0.95em;"><span style="color: #94a3b8; margin-right: 6px;">◦</span>$1</div>');
  
  // Code: `code`
  formatted = formatted.replace(/`([^`]+)`/g, '<code style="background: #0f172a; padding: 2px 6px; border-radius: 3px; color: #10b981; font-family: monospace; font-size: 0.9em;">$1</code>');
  
  // Preserve line breaks
  formatted = formatted.replace(/\n\n/g, '<div style="margin: 12px 0;"></div>');
  formatted = formatted.replace(/\n/g, '<br>');
  
  return formatted;
}

export async function loadReasoningTraces() {
  const element = document.getElementById('reasoning-traces');
  if (!element) return;
  
  // Show skeleton loader
  element.innerHTML = '';
  element.appendChild(createSkeletonLoader('Loading reasoning traces...'));
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/reasoning-traces?limit=20`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    if (!data.traces || data.traces.length === 0) {
      element.innerHTML = '<p>No reasoning traces found.</p>';
      return;
    }
    
    const html = data.traces.map(trace => `
      <div class="panel" style="margin-bottom: 30px; border-left: 2px solid ${trace.maxStepsReached ? '#ef4444' : '#10b981'};">
        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 15px;">
          <div>
            <h3 style="margin: 0 0 10px 0; color: #f97316;">
              Trace ${trace.id.slice(0, 8)}
              <button 
                onclick="navigator.clipboard.writeText('${trace.id}'); this.style.background='#f97316'; setTimeout(() => this.style.background='transparent', 200);"
                style="
                  background: transparent;
                  border: 1px solid #334155;
                  color: #94a3b8;
                  padding: 2px 6px;
                  border-radius: 3px;
                  cursor: pointer;
                  margin-left: 8px;
                  font-size: 0.7em;
                  display: inline-flex;
                  align-items: center;
                  gap: 4px;
                "
                title="Copy full trace ID"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
                </svg>
              </button>
            </h3>
            <div style="font-size: 0.875rem; color: #94a3b8; line-height: 1.6;">
              <div><strong style="color: #e2e8f0;">Input:</strong> <span style="color: #cbd5e1;">${trace.userInput}</span></div>
              <div style="margin-top: 5px;">
                <span style="margin-right: 15px;"><strong>User:</strong> ${trace.userId}</span>
                <span style="margin-right: 15px;"><strong>ACL:</strong> ${trace.aclGroup}</span>
                <span style="margin-right: 15px;"><strong>Steps:</strong> ${trace.totalSteps}</span>
                <span style="margin-right: 15px;"><strong>Tools:</strong> ${trace.totalToolCalls}</span>
                <span><strong>Duration:</strong> ${trace.durationMs}ms</span>
              </div>
              <div style="margin-top: 5px;">
                <span class="status-badge ${trace.maxStepsReached ? 'status-error' : 'status-success'}" style="margin-right: 10px;">
                  ${trace.maxStepsReached ? 'Max Steps Reached' : 'Completed'}
                </span>
                <span style="color: #94a3b8;">${new Date(trace.timestamp).toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>
        
        <div style="margin-top: 20px;">
          ${trace.steps.map((step, idx) => `
            <div style="margin-bottom: 20px; padding: 15px; background: #0f172a; border: 1px solid #334155; border-radius: 6px;">
              <div style="display: flex; align-items: center; margin-bottom: 10px;">
                <span style="background: #f97316; color: white; padding: 4px 10px; border-radius: 4px; font-weight: 600; margin-right: 10px;">
                  Step ${step.step}
                </span>
                ${step.ragContext ? `
                  <span style="background: #8b5cf6; color: white; padding: 4px 10px; border-radius: 4px; font-size: 0.75rem; margin-right: 10px;">
                    RAG: ${step.ragContext.queryType}
                  </span>
                ` : ''}
                ${step.toolCalls.length > 0 ? `
                  <span style="background: #10b981; color: white; padding: 4px 10px; border-radius: 4px; font-size: 0.75rem;">
                    ${step.toolCalls.length} tool${step.toolCalls.length > 1 ? 's' : ''}
                  </span>
                ` : ''}
              </div>
              
              ${step.llmResponse ? `
                <div style="margin-bottom: 10px; padding: 10px; background: #1e293b; border-radius: 4px; border-left: 2px solid #f97316;">
                  <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px;">LLM Response</div>
                  <div style="color: #e2e8f0; line-height: 1.5; font-size: 0.875rem;">${formatFinalResponse(step.llmResponse)}</div>
                </div>
              ` : ''}
              
              ${step.ragContext ? `
                <div style="margin-bottom: 10px; padding: 10px; background: #1e293b; border-radius: 4px; border-left: 2px solid #8b5cf6;">
                  <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px;">RAG Context</div>
                  <div style="color: #e2e8f0; font-size: 0.875rem;">
                    <div><strong>Type:</strong> ${step.ragContext.queryType}</div>
                    <div><strong>Score:</strong> ${(step.ragContext.sTotalScore || 0).toFixed(3)}</div>
                    <div><strong>Sources:</strong> ${step.ragContext.sourcesCount}</div>
                  </div>
                </div>
              ` : ''}
              
              ${step.toolCalls.length > 0 ? `
                <div style="margin-bottom: 10px;">
                  <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">Tool Calls</div>
                  ${step.toolCalls.map(tc => `
                    <div style="margin-bottom: 8px; padding: 10px; background: #1e293b; border-radius: 4px; border-left: 2px solid ${tc.result.success ? '#10b981' : '#ef4444'};">
                      <div style="display: flex; align-items: center; margin-bottom: 5px;">
                        <span style="color: #f97316; font-weight: 600; margin-right: 10px;">${tc.toolName}</span>
                        <span class="status-badge ${tc.result.success ? 'status-success' : 'status-error'}" style="margin-right: 10px;">
                          ${tc.result.success ? 'Success' : 'Failed'}
                        </span>
                        <span style="color: #94a3b8; font-size: 0.75rem;">${tc.durationMs}ms</span>
                      </div>
                      <div style="margin-top: 5px;">
                        <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 3px;">Parameters:</div>
                        <pre style="background: #0f172a; padding: 8px; border-radius: 4px; font-size: 0.75rem; overflow-x: auto; margin: 0;">${JSON.stringify(tc.parameters, null, 2)}</pre>
                      </div>
                      ${tc.result.error ? `
                        <div style="margin-top: 5px; color: #ef4444; font-size: 0.875rem;">
                          <strong>Error:</strong> ${tc.result.error}
                        </div>
                      ` : tc.result.dataPreview ? `
                        <div style="margin-top: 8px;">
                          <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">Result</div>
                          ${formatToolResult(tc.result.dataPreview, tc.toolName)}
                        </div>
                      ` : ''}
                    </div>
                  `).join('')}
                </div>
              ` : ''}
              
              ${step.decisions.length > 0 ? `
                <div style="margin-top: 10px;">
                  <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">Decisions</div>
                  ${step.decisions.map(d => {
                    const colors = {
                      'duplicate_detected': '#f59e0b',
                      'limit_reached': '#ef4444',
                      'fallback': '#8b5cf6',
                      'tool_choice': '#10b981',
                      'rag_used': '#f97316'
                    };
                    const color = colors[d.type] || '#94a3b8';
                    return `
                    <div style="margin-bottom: 5px; padding: 6px 10px; background: #1e293b; border-radius: 4px; border-left: 2px solid ${color};">
                      <span style="color: ${color}; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; margin-right: 8px;">${d.type.replace('_', ' ')}</span>
                      <span style="color: #e2e8f0; font-size: 0.875rem;">${d.description}</span>
                    </div>
                  `;
                  }).join('')}
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
        
        ${trace.finalResponse ? `
          <div style="margin-top: 20px; padding: 15px; background: #1e293b; border-radius: 6px; border-left: 2px solid #10b981;">
            <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px;">Final Response</div>
            <div style="color: #e2e8f0; line-height: 1.6; font-size: 0.9rem;" class="formatted-response">${formatFinalResponse(trace.finalResponse)}</div>
          </div>
        ` : ''}
      </div>
    `).join('');
    
    element.innerHTML = html;
  } catch (error) {
    element.innerHTML = 
      `<div class="error">Failed to load reasoning traces: ${error.message}</div>`;
  }
}
