import { readFileSync } from 'node:fs'
import ts from 'typescript'

/** Resolve original runtime exports, including aliased icons; type-only specifiers emit no JavaScript. */
export function lucideMockSource(files) {
  const names = new Set()
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== 'lucide-react' || node.importClause?.isTypeOnly) continue
      const bindings = node.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const specifier of bindings.elements) {
        if (!specifier.isTypeOnly) names.add((specifier.propertyName ?? specifier.name).text)
      }
    }
  }
  return [...names].map(name => `export const ${name} = () => null;`).join('\n')
}
