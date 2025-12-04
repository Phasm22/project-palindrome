import { API_URL } from './utils.js';

export async function loadReasoningTraces() {
  const element = document.getElementById('reasoning-traces');
  if (!element) return;
  
  element.innerHTML = '<div class="loading">Loading...</div>';
  
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
      <div class="panel" style="margin-bottom: 30px; border-left: 3px solid ${trace.maxStepsReached ? '#ef4444' : '#10b981'};">
        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 15px;">
          <div>
            <h3 style="margin: 0 0 10px 0; color: #60a5fa;">Trace ${trace.id.slice(0, 8)}</h3>
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
                <span style="background: #3b82f6; color: white; padding: 4px 10px; border-radius: 4px; font-weight: 600; margin-right: 10px;">
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
                <div style="margin-bottom: 10px; padding: 10px; background: #1e293b; border-radius: 4px; border-left: 3px solid #60a5fa;">
                  <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px;">LLM Response</div>
                  <div style="color: #e2e8f0; white-space: pre-wrap; font-family: 'Courier New', monospace; font-size: 0.875rem;">${step.llmResponse}</div>
                </div>
              ` : ''}
              
              ${step.ragContext ? `
                <div style="margin-bottom: 10px; padding: 10px; background: #1e293b; border-radius: 4px; border-left: 3px solid #8b5cf6;">
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
                    <div style="margin-bottom: 8px; padding: 10px; background: #1e293b; border-radius: 4px; border-left: 3px solid ${tc.result.success ? '#10b981' : '#ef4444'};">
                      <div style="display: flex; align-items: center; margin-bottom: 5px;">
                        <span style="color: #60a5fa; font-weight: 600; margin-right: 10px;">${tc.toolName}</span>
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
                        <div style="margin-top: 5px;">
                          <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 3px;">Result Preview:</div>
                          <pre style="background: #0f172a; padding: 8px; border-radius: 4px; font-size: 0.75rem; overflow-x: auto; margin: 0; max-height: 100px; overflow-y: auto;">${tc.result.dataPreview}</pre>
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
                      'rag_used': '#3b82f6'
                    };
                    const color = colors[d.type] || '#94a3b8';
                    return `
                    <div style="margin-bottom: 5px; padding: 6px 10px; background: #1e293b; border-radius: 4px; border-left: 3px solid ${color};">
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
          <div style="margin-top: 20px; padding: 15px; background: #1e293b; border-radius: 6px; border-left: 3px solid #10b981;">
            <div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px;">Final Response</div>
            <div style="color: #e2e8f0; white-space: pre-wrap; font-family: 'Courier New', monospace;">${trace.finalResponse}</div>
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
