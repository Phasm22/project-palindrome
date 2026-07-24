import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

export function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(import.meta.dir, "../..", relativePath), "utf8");
}

export function parseRepoFile(
  relativePath: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TS
): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readRepoFile(relativePath),
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
}

export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

export function propertyNameText(
  name: ts.PropertyName,
  sourceFile: ts.SourceFile
): string {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return name.getText(sourceFile);
}
