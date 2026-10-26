import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as lucide from "lucide-react";

const combatSource = resolve(process.cwd(), "src/routes/_authenticated/combate.tsx");

describe("Ícones e referências JSX do Combate", () => {
  it("não utiliza ícones Lucide ausentes dos imports", () => {
    const source = ts.createSourceFile(
      combatSource, readFileSync(combatSource, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
    );
    const declared = new Set<string>();
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause;
        if (clause.name) declared.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const specifier of bindings.elements) declared.add(specifier.name.text);
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          declared.add(bindings.name.text);
        }
      }
      if (ts.isFunctionDeclaration(statement) && statement.name) declared.add(statement.name.text);
      if (ts.isClassDeclaration(statement) && statement.name) declared.add(statement.name.text);
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) declared.add(decl.name.text);
        }
      }
    }
    const referenced = new Set<string>();
    const check = (node: ts.Node) => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName)) {
        referenced.add(node.tagName.text);
      }
      ts.forEachChild(node, check);
    };
    check(source);

    // Catches runtime errors such as "Repeat2 is not defined", which a
    // bundler build without a TypeScript semantic check does not catch.
    const lucideExports = new Set(Object.keys(lucide));
    const missing = [...referenced].filter(name => name !== "Icon" && lucideExports.has(name) && !declared.has(name));
    expect(missing, "Ícones JSX do Combate sem import ou declaração").toEqual([]);
  });
});
