#!/bin/bash
# Run all Proxmox tests and show detailed results

BUN_PATH="${HOME}/.bun/bin/bun"

echo "=========================================="
echo "Proxmox Test Suite - Detailed Results"
echo "=========================================="
echo ""

echo "1. Testing Client (TL-2A.1)..."
echo "----------------------------------------"
$BUN_PATH test tests/tools/proxmox/readonly/client.test.ts 2>&1
echo ""

echo "2. Testing Base Class (TL-2A.1)..."
echo "----------------------------------------"
$BUN_PATH test tests/tools/proxmox/readonly/base.test.ts 2>&1
echo ""

echo "3. Testing Tool Actions (TL-2A.2)..."
echo "----------------------------------------"
$BUN_PATH test tests/tools/proxmox/readonly/proxmox-readonly-tool.test.ts 2>&1
echo ""

echo "4. Testing Redaction (TL-2A.4)..."
echo "----------------------------------------"
$BUN_PATH test tests/tools/proxmox/readonly/redaction.test.ts 2>&1
echo ""

echo "5. Testing Normalization (TL-2A.5)..."
echo "----------------------------------------"
$BUN_PATH test tests/tools/proxmox/readonly/normalization.test.ts 2>&1
echo ""

echo "6. Testing Vector Ingestion (TL-2A.6.A)..."
echo "----------------------------------------"
$BUN_PATH test tests/tools/proxmox/readonly/vector-ingestion.test.ts 2>&1
echo ""

echo "7. Testing Graph Ingestion (TL-2A.6.B)..."
echo "----------------------------------------"
$BUN_PATH test tests/tools/proxmox/readonly/graph-ingestion.test.ts 2>&1
echo ""

echo "8. Testing Hybrid Reasoning (TL-2A.7)..."
echo "----------------------------------------"
$BUN_PATH test tests/flows/proxmox_hybrid_reasoning.test.ts 2>&1
echo ""

echo "=========================================="
echo "Summary: Run individual tests above to see detailed errors"
echo "=========================================="

