#!/bin/bash
# Comprehensive Test Execution Script
# Runs all test suites in order and reports failures

set -e

echo "=========================================="
echo "Comprehensive Test Execution"
echo "=========================================="
echo ""

FAILURES=()
PASSED=0
FAILED=0

# Function to run tests and track results
run_test_suite() {
    local suite_name="$1"
    local test_file="$2"
    local grep_pattern="${3:-}"
    
    echo "----------------------------------------"
    echo "Running: $suite_name"
    echo "File: $test_file"
    echo "----------------------------------------"
    
    if [ -n "$grep_pattern" ]; then
        bun test "$test_file" --grep "$grep_pattern" 2>&1 | tee /tmp/test-output.txt
    else
        bun test "$test_file" 2>&1 | tee /tmp/test-output.txt
    fi
    
    local exit_code=${PIPESTATUS[0]}
    
    # Parse test results
    local passed=$(grep -c "✓\|(pass)" /tmp/test-output.txt 2>/dev/null | head -1)
    local failed=$(grep -c "✗\|(fail)" /tmp/test-output.txt 2>/dev/null | head -1)
    
    # Ensure values are numeric (handle empty strings)
    if [ -z "$passed" ] || [ "$passed" = "" ]; then
        passed=0
    fi
    if [ -z "$failed" ] || [ "$failed" = "" ]; then
        failed=0
    fi
    
    # Convert to integers explicitly
    passed=$((passed + 0))
    failed=$((failed + 0))
    
    PASSED=$((PASSED + passed))
    FAILED=$((FAILED + failed))
    
    if [ $exit_code -ne 0 ] || [ $failed -gt 0 ]; then
        FAILURES+=("$suite_name: $failed failures")
        echo "❌ FAILED: $suite_name ($failed failures)"
    else
        echo "✅ PASSED: $suite_name"
    fi
    
    echo ""
}

# Phase I-A: Foundation
echo "=========================================="
echo "Phase I-A: Foundation Tests"
echo "=========================================="
run_test_suite "Phase I-A: DOD Tests" "tests/pce/dod.test.ts"
run_test_suite "Phase I-A: Redaction" "tests/pce/redaction.test.ts"
run_test_suite "Phase I-A: DLM" "tests/pce/dlm.test.ts"

# Phase I-B: Knowledge Graph
echo "=========================================="
echo "Phase I-B: Knowledge Graph Tests"
echo "=========================================="
run_test_suite "Phase I-B: DOD Tests" "tests/pce/phase-ib-dod.test.ts"
run_test_suite "Phase I-B: KG Test Harness" "tests/pce/kg/test-harness.test.ts"

# Phase I-C: Hybrid Orchestration
echo "=========================================="
echo "Phase I-C: Hybrid Orchestration Tests"
echo "=========================================="
run_test_suite "Phase I-C: DOD Tests" "tests/pce/phase-ic-dod.test.ts"
run_test_suite "Phase I-C: Hybrid Orchestrator Score" "tests/pce/hybrid-orchestrator-score.test.ts"

# Phase II: Real-Time & Scaling
echo "=========================================="
echo "Phase II: Real-Time & Scaling Tests"
echo "=========================================="
run_test_suite "Phase II: DOD Tests" "tests/pce/phase-ii-dod.test.ts"

# Phase III: External API & Security
echo "=========================================="
echo "Phase III: External API & Security Tests"
echo "=========================================="
run_test_suite "Phase III: API Server" "tests/pce/api/api-server.test.ts"
run_test_suite "Phase III: Cognitive Tools" "tests/tools/cognitive-tools.test.ts"
run_test_suite "Phase III: RAG ACL" "tests/pce/rag/retrieval-acl.test.ts"
run_test_suite "Phase III: Graph ACL" "tests/pce/graph/graph-acl.test.ts"
run_test_suite "Phase III: Tool Sanitizer" "tests/agent/tool-sanitizer.test.ts"

# Phase TL-1A: OPNsense Read-Only
echo "=========================================="
echo "Phase TL-1A: OPNsense Read-Only Tests"
echo "=========================================="
run_test_suite "Phase TL-1A: Read-Only Tools" "tests/tools/opnsense/readonly/opnsense-readonly.test.ts"
run_test_suite "Phase TL-1A: PCE Integration" "tests/tools/opnsense/readonly/pce-integration.test.ts"

# Phase TL-1B: OPNsense Safe Write
echo "=========================================="
echo "Phase TL-1B: OPNsense Safe Write Tests"
echo "=========================================="
run_test_suite "Phase TL-1B: Safe Write Tools" "tests/tools/opnsense/writes/opnsense-safewrite.test.ts"

# Phase TL-1C: LLM-Integrated Tool Use
echo "=========================================="
echo "Phase TL-1C: LLM-Integrated Tool Use Tests"
echo "=========================================="
run_test_suite "Phase TL-1C: LLM Tool Calling" "tests/flows/opnsense_llm_tool_calling.test.ts"
run_test_suite "Phase TL-1C: Diagnostic Reasoning" "tests/flows/opnsense_diagnostic_reasoning.test.ts"
run_test_suite "Phase TL-1C: Assisted Config" "tests/flows/opnsense_assisted_config.test.ts"
run_test_suite "Phase TL-1C: Provenance" "tests/flows/opnsense_provenance.test.ts"
run_test_suite "Phase TL-1C: Unified Schema" "tests/flows/opnsense_unified_schema.test.ts"

# Phase TL-2A: Proxmox Read-Only
echo "=========================================="
echo "Phase TL-2A: Proxmox Read-Only Tests"
echo "=========================================="
run_test_suite "Phase TL-2A.1: Client" "tests/tools/proxmox/readonly/client.test.ts"
run_test_suite "Phase TL-2A.2: Base" "tests/tools/proxmox/readonly/base.test.ts"
run_test_suite "Phase TL-2A.2: Tool Actions" "tests/tools/proxmox/readonly/proxmox-readonly-tool.test.ts"
run_test_suite "Phase TL-2A.4: Redaction" "tests/tools/proxmox/readonly/redaction.test.ts"
run_test_suite "Phase TL-2A.5: Normalization" "tests/tools/proxmox/readonly/normalization.test.ts"
run_test_suite "Phase TL-2A.6.A: Vector Ingestion" "tests/tools/proxmox/readonly/vector-ingestion.test.ts"
run_test_suite "Phase TL-2A.6.B: Graph Ingestion" "tests/tools/proxmox/readonly/graph-ingestion.test.ts"
run_test_suite "Phase TL-2A.7: Hybrid Reasoning" "tests/flows/proxmox_hybrid_reasoning.test.ts"

# Core Infrastructure Tests
echo "=========================================="
echo "Core Infrastructure Tests"
echo "=========================================="
run_test_suite "Agent Context" "tests/agent-context.test.ts"
run_test_suite "Base Tool" "tests/basetool.test.ts"
run_test_suite "CLI" "tests/cli.test.ts"
run_test_suite "Runner" "tests/runner.test.ts"
run_test_suite "Tool Executor" "tests/tool-executor.test.ts"

# Summary
echo "=========================================="
echo "Test Execution Summary"
echo "=========================================="
echo "Total Tests Passed: $PASSED"
echo "Total Tests Failed: $FAILED"
echo ""

if [ ${#FAILURES[@]} -gt 0 ]; then
    echo "Failed Test Suites:"
    for failure in "${FAILURES[@]}"; do
        echo "  - $failure"
    done
    echo ""
    exit 1
else
    echo "✅ All test suites passed!"
    exit 0
fi

