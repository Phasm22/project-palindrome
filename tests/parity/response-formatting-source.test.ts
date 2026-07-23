import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { MODE_INSTRUCTIONS } from "../../src/agent/system-prompt";
import { parseRepoFile, propertyNameText, readRepoFile, walk } from "./source-ast";

const MODE_NAMES = Object.keys(MODE_INSTRUCTIONS);

describe("response formatting has one instruction source", () => {
  test("response-formatter derives modes from system-prompt instead of redefining them", () => {
    const relativePath = "src/agent/response-formatter.ts";
    const source = readRepoFile(relativePath);
    const sourceFile = parseRepoFile(relativePath);
    const importedModeInstructions: string[] = [];
    const indexedModeLookups: string[] = [];
    const duplicateModeProperties: string[] = [];

    walk(sourceFile, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "./system-prompt"
      ) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          importedModeInstructions.push(
            ...bindings.elements.map((element) => element.name.text)
          );
        }
      }

      if (
        ts.isElementAccessExpression(node) &&
        node.expression.getText(sourceFile) === "MODE_INSTRUCTIONS"
      ) {
        indexedModeLookups.push(node.argumentExpression.getText(sourceFile));
      }

      if (
        (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
        MODE_NAMES.includes(propertyNameText(node.name, sourceFile))
      ) {
        duplicateModeProperties.push(propertyNameText(node.name, sourceFile));
      }
    });

    expect(importedModeInstructions).toContain("MODE_INSTRUCTIONS");
    expect(indexedModeLookups).toContain("context.mode");
    expect(duplicateModeProperties).toEqual([]);

    for (const canonicalInstruction of Object.values(MODE_INSTRUCTIONS)) {
      expect(source).not.toContain(canonicalInstruction);
    }
  });

  test("response-formatter honors the configured model and does not restore gpt-4o-mini", () => {
    const source = readRepoFile("src/agent/response-formatter.ts");

    expect(source).toContain("process.env.AGENT_CHAT_MODEL");
    expect(source).not.toContain("gpt-4o-mini");
  });
});
