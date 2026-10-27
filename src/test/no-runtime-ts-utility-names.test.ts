import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path=join(dir,name);
    if (name === "node_modules" || name === "dist" || name === ".git") return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|mts)$/.test(name) ? [path] : [];
  });
}

/** TS Record<...> must appear only in a type position, never JSX/runtime. */
describe("Tipagens não podem virar referências de JavaScript", () => {
  it("não referencia Record como valor na interface", () => {
    const root=resolve(process.cwd(),"src");
    const problems:string[]=[];
    for(const path of sourceFiles(root)) {
      const content=readFileSync(path,"utf8");
      if(!/\bRecord\b/.test(content))continue;
      const ast=ts.createSourceFile(path,content,ts.ScriptTarget.Latest,true,
        path.endsWith(".tsx")?ts.ScriptKind.TSX:ts.ScriptKind.TS);
      function walk(node:ts.Node) {
        if(ts.isIdentifier(node)&&node.text==="Record"){
          const parent=node.parent;
          const typePosition=ts.isTypeReferenceNode(parent) || ts.isImportSpecifier(parent)
            || ts.isExportSpecifier(parent) || ts.isTypeParameterDeclaration(parent)
            || ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent);
          if(!typePosition){
            const pos=ast.getLineAndCharacterOfPosition(node.getStart(ast));
            problems.push(relative(root,path)+":"+(pos.line+1)+":"+(pos.character+1)+
              " (runtime Record in "+ts.SyntaxKind[parent.kind]+")");
          }
        }
        ts.forEachChild(node,walk);
      }
      walk(ast);
    }
    expect(problems).toEqual([]);
  });
});