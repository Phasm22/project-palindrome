import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { parseRepoFile, readRepoFile, walk } from "./source-ast";

function findFunction(
  sourceFile: ts.SourceFile,
  name: string
): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  walk(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
    }
  });
  if (!found) throw new Error(`Function ${name} was not found`);
  return found;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function auditMapCallback(
  callback: ts.Expression,
  sourceFile: ts.SourceFile,
  violations: string[]
): void {
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
    violations.push(`non-function map callback: ${callback.getText(sourceFile)}`);
    return;
  }

  if (ts.isBlock(callback.body)) {
    walk(callback.body, (node) => {
      if (ts.isReturnStatement(node) && node.expression) {
        auditHtmlExpression(node.expression, sourceFile, violations);
      }
    });
    return;
  }
  auditHtmlExpression(callback.body, sourceFile, violations);
}

/*
 * Proves that an expression inserted into HTML is either:
 * - escaped at the leaf,
 * - made only from fixed literals,
 * - a nested template whose own interpolations pass this same audit,
 * - a joined map whose callback passes this same audit, or
 * - delegated to the shared adaptive renderer (checked separately below).
 */
function auditHtmlExpression(
  rawExpression: ts.Expression,
  sourceFile: ts.SourceFile,
  violations: string[]
): void {
  const expression = unwrapExpression(rawExpression);

  if (
    ts.isStringLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  ) {
    return;
  }

  if (ts.isCallExpression(expression)) {
    if (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "escapeHtml"
    ) {
      return;
    }
    if (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "renderAdaptiveValue" &&
      expression.arguments[0]?.getText(sourceFile) === "data"
    ) {
      return;
    }

    if (
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === "join"
    ) {
      const mapCall = unwrapExpression(expression.expression.expression);
      if (
        ts.isCallExpression(mapCall) &&
        ts.isPropertyAccessExpression(mapCall.expression) &&
        mapCall.expression.name.text === "map" &&
        mapCall.arguments[0]
      ) {
        auditMapCallback(mapCall.arguments[0], sourceFile, violations);
        return;
      }
    }
  }

  if (ts.isConditionalExpression(expression)) {
    auditHtmlExpression(expression.whenTrue, sourceFile, violations);
    auditHtmlExpression(expression.whenFalse, sourceFile, violations);
    return;
  }

  if (ts.isTemplateExpression(expression)) {
    for (const span of expression.templateSpans) {
      auditHtmlExpression(span.expression, sourceFile, violations);
    }
    return;
  }

  violations.push(expression.getText(sourceFile));
}

describe("reasoning tool-result renderer escaping completeness", () => {
  test("every formatToolResult HTML interpolation is escaped or structurally safe", () => {
    const sourceFile = parseRepoFile(
      "dashboard/js/reasoning.js",
      ts.ScriptKind.JS
    );
    const formatToolResult = findFunction(sourceFile, "formatToolResult");
    const violations: string[] = [];
    let auditedReturns = 0;

    walk(formatToolResult.body!, (node) => {
      if (ts.isReturnStatement(node) && node.expression) {
        auditedReturns++;
        auditHtmlExpression(node.expression, sourceFile, violations);
      }
    });

    expect(auditedReturns).toBeGreaterThan(5);
    expect(violations).toEqual([]);
  });

  test("the adaptive-renderer exception escapes arbitrary scalar content", () => {
    const reasoning = readRepoFile("dashboard/js/reasoning.js");
    const adaptiveRenderer = readRepoFile("dashboard/js/response-renderer.js");

    expect(reasoning).toContain(
      'import { renderTextBlock, renderAdaptiveValue } from \'./response-renderer.js\';'
    );
    expect(adaptiveRenderer).toMatch(
      /function\s+renderInlineText\([^)]*\)\s*\{[\s\S]*?return\s+escapeHtml\(part\);/
    );
    expect(adaptiveRenderer).toMatch(
      /function\s+renderScalar\([^)]*\)\s*\{[\s\S]*?renderInlineText\(value\)/
    );
  });
});
