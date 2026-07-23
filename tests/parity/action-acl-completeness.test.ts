import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { parseRepoFile, propertyNameText, readRepoFile, walk } from "./source-ast";

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function findObjectVariable(
  sourceFile: ts.SourceFile,
  variableName: string
): ts.ObjectLiteralExpression {
  let initializer: ts.Expression | undefined;
  walk(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer
    ) {
      initializer = node.initializer;
    }
  });

  if (!initializer) throw new Error(`${variableName} was not found`);
  const unwrapped = unwrapExpression(initializer);
  if (!ts.isObjectLiteralExpression(unwrapped)) {
    throw new Error(`${variableName} is not an object literal`);
  }
  return unwrapped;
}

function centralActionAcls(sourceFile: ts.SourceFile): Record<string, string[]> {
  const securityMap = findObjectVariable(sourceFile, "ACTION_SECURITY");
  const entries: Record<string, string[]> = {};

  for (const property of securityMap.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(
        `ACTION_SECURITY contains a non-property entry: ${property.getText(sourceFile)}`
      );
    }
    const actionName = propertyNameText(property.name, sourceFile);
    const value = unwrapExpression(property.initializer);
    if (!ts.isObjectLiteralExpression(value)) {
      throw new Error(`ACTION_SECURITY[${actionName}] is not an object literal`);
    }
    const aclProperty = value.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        propertyNameText(candidate.name, sourceFile) === "acl"
    );
    if (!aclProperty) {
      entries[actionName] = [];
      continue;
    }
    const aclValue = unwrapExpression(aclProperty.initializer);
    entries[actionName] = ts.isArrayLiteralExpression(aclValue)
      ? aclValue.elements.flatMap((element) =>
          ts.isStringLiteral(element) ? [element.text] : []
        )
      : [];
  }

  return entries;
}

function registeredActionSecurityRefs(
  sourceFile: ts.SourceFile
): Record<string, string | null> {
  const registrations: Record<string, string | null> = {};

  walk(sourceFile, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.expression.getText(sourceFile) !== "actionRegistry" ||
      node.expression.name.text !== "register"
    ) {
      return;
    }

    const registration = node.arguments[0];
    if (!registration || !ts.isObjectLiteralExpression(registration)) {
      throw new Error("actionRegistry.register must receive an object literal");
    }
    const nameProperty = registration.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        propertyNameText(property.name, sourceFile) === "name"
    );
    if (!nameProperty || !ts.isStringLiteral(nameProperty.initializer)) {
      throw new Error("registered action must have a string-literal name");
    }
    const actionName = nameProperty.initializer.text;

    const securitySpread = registration.properties.find((property) => {
      if (!ts.isSpreadAssignment(property)) return false;
      const expression = unwrapExpression(property.expression);
      return (
        ts.isElementAccessExpression(expression) &&
        expression.expression.getText(sourceFile) === "ACTION_SECURITY"
      );
    });
    if (!securitySpread || !ts.isSpreadAssignment(securitySpread)) {
      registrations[actionName] = null;
      return;
    }
    const expression = unwrapExpression(securitySpread.expression);
    registrations[actionName] =
      ts.isElementAccessExpression(expression) &&
      expression.argumentExpression &&
      ts.isStringLiteral(expression.argumentExpression)
        ? expression.argumentExpression.text
        : null;
  });

  return registrations;
}

describe("ActionTool ACL completeness", () => {
  test("every registered action has a non-empty ACL from the central per-action map", () => {
    const sourceFile = parseRepoFile("src/actions/registry.ts");
    const acls = centralActionAcls(sourceFile);
    const registrations = registeredActionSecurityRefs(sourceFile);

    expect(Object.keys(registrations).sort()).toEqual(Object.keys(acls).sort());
    for (const [actionName, securityRef] of Object.entries(registrations)) {
      expect(securityRef).toBe(actionName);
      expect(acls[actionName]?.length).toBeGreaterThan(0);
      expect(acls[actionName]?.every((acl) => acl.trim().length > 0)).toBe(true);
    }
  });

  test("ActionTool enumerates, dispatches, and enforces the same action registry", () => {
    const source = readRepoFile("src/tools/ActionTool.ts");

    expect(source).toMatch(/actionRegistry\.list\(\)/);
    expect(source).toMatch(/actionRegistry\.get\(action\)/);
    expect(source).toMatch(
      /actionDef\.acl[\s\S]*?actionDef\.acl\.length\s*>\s*0[\s\S]*?!actionDef\.acl\.includes\(aclGroup\)/
    );
  });
});
