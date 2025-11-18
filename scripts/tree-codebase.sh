#!/bin/bash
# Tree command to visualize codebase structure, excluding dependencies and build artifacts

tree -L 4 \
  -I 'node_modules|.git|dist|build|.next|.cache|coverage|.bun|*.log|.DS_Store' \
  --dirsfirst \
  -a \
  2>/dev/null || echo "tree command not found. Install with: brew install tree"

