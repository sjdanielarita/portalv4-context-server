import path from "node:path";
import { describeSource, readLogTraitContext, readProjectSource } from "./logtrait-context.js";

export type ModelAuditMode = "new" | "legacy";
type AuditRule = "LOGTRAIT_MISSING" | "MODEL_BOOT_PARENT_MISSING" |
  "LOGTRAIT_BOOT_OVERRIDE" | "LOGTRAIT_LOGBD_OVERRIDE" |
  "LOGTRAIT_UNSUPPORTED_FILTER_CONFIG" | "MODEL_AUDIT_UNRESOLVED";
interface Finding {
  rule: AuditRule;
  severity: "error" | "warning" | "review";
  line: number;
  column: number;
  message: string;
}
interface Token { value: string; offset: number; literal?: boolean }

/** A bounded lexical inspection, not a PHP parser. Never execute inspected PHP. */
function tokenize(source: string): { tokens: Token[]; unresolved: boolean } {
  const tokens: Token[] = [];
  let unresolved = false;
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) { index += whitespace[0].length; continue; }
    const tag = /^(?:<\?php\b|<\?=|\?>)/i.exec(rest);
    if (tag) {
      if (tag[0].toLowerCase() !== "<?php") unresolved = true;
      index += tag[0].length;
      continue;
    }
    if (rest.startsWith("//") || (rest.startsWith("#") && !rest.startsWith("#["))) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) { unresolved = true; break; }
      index = end + 2;
      continue;
    }
    if (rest.startsWith("<<<") || rest.startsWith("#[")) {
      unresolved = true; // Heredoc/nowdoc and attributes require a complete PHP parser.
      break;
    }
    const quote = source[index];
    if (quote === "'" || quote === '"' || quote === "`") {
      const offset = index++;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index++] === quote) { closed = true; break; }
      }
      if (!closed || quote === "`") unresolved = true;
      tokens.push({ value: "<literal>", offset, literal: true });
      continue;
    }
    const name = /^(?:\$[A-Za-z_]\w*|\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*)/.exec(rest);
    const operator = /^(?:\?->|->|::)/.exec(rest);
    const value = name?.[0] ?? operator?.[0] ?? source[index]!;
    tokens.push({ value, offset: index });
    index += value.length;
  }
  const stack: string[] = [];
  const closings: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
  for (const token of tokens) {
    if (["{", "(", "["].includes(token.value)) stack.push(token.value);
    else if (closings[token.value] && stack.pop() !== closings[token.value]) unresolved = true;
  }
  if (stack.length) unresolved = true;
  return { tokens, unresolved };
}

function closingBrace(tokens: Token[], opening: number): number {
  let depth = 0;
  for (let index = opening; index < tokens.length; index++) {
    if (tokens[index]!.value === "{") depth++;
    if (tokens[index]!.value === "}" && --depth === 0) return index;
  }
  return tokens.length;
}

function resolveName(name: string, namespace: string, imports: Map<string, string>): string {
  if (name.startsWith("\\")) return name.slice(1).toLowerCase();
  if (name.toLowerCase().startsWith("namespace\\")) {
    return `${namespace}\\${name.slice(10)}`.toLowerCase();
  }
  const [first = "", ...rest] = name.split("\\");
  const imported = imports.get(first.toLowerCase());
  return (imported ? [imported, ...rest].join("\\") :
    [namespace, name].filter(Boolean).join("\\")).toLowerCase();
}

export function inspectModelAudit(source: string, mode: ModelAuditMode) {
  const lexical = tokenize(source);
  const { tokens } = lexical;
  const findings: Finding[] = [];
  let unresolved = lexical.unresolved;
  const add = (rule: AuditRule, severity: Finding["severity"], token: Token | undefined, message: string) => {
    const prefix = source.slice(0, token?.offset ?? 0).split(/\r?\n/);
    findings.push({ rule, severity, line: prefix.length,
      column: (prefix.at(-1)?.length ?? 0) + 1, message });
  };
  const imports = new Map<string, string>();
  let namespace = "";
  let namespaceCount = 0;
  const classes: number[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const lower = token.value.toLowerCase();
    if (lower === "namespace") {
      namespaceCount++;
      namespace = tokens[index + 1]?.value ?? "";
      if (tokens[index + 2]?.value !== ";" || namespaceCount > 1) unresolved = true;
    } else if (lower === "use") {
      const end = tokens.findIndex((item, position) => position > index && item.value === ";");
      if (end === -1) { unresolved = true; break; }
      const statement = tokens.slice(index + 1, end);
      if (statement.some(item => item.value === "{")) { unresolved = true; index = end; continue; }
      const segments: Token[][] = [[]];
      for (const item of statement) {
        if (item.value === ",") segments.push([]);
        else segments.at(-1)!.push(item);
      }
      for (const segment of segments) {
        const name = segment[0]?.value;
        if (name === "function" || name === "const") continue;
        if (!name || !(segment.length === 1 || (segment.length === 3 && segment[1]?.value.toLowerCase() === "as"))) {
          unresolved = true; continue;
        }
        const alias = segment.length === 3 ? segment[2]!.value : name.split("\\").at(-1)!;
        if (imports.has(alias.toLowerCase())) unresolved = true;
        imports.set(alias.toLowerCase(), name.replace(/^\\/, ""));
      }
      index = end;
    } else if (lower === "class" && tokens[index - 1]?.value !== "::") {
      classes.push(index);
      const open = tokens.findIndex((item, position) => position > index && item.value === "{");
      if (open === -1) { unresolved = true; break; }
      index = closingBrace(tokens, open);
    } else if (lower === "trait" || lower === "interface" || lower === "enum") {
      unresolved = true;
    }
  }
  if (classes.length !== 1) unresolved = true;
  const classIndex = classes[0];
  let hasLogTrait = false;
  let hasOtherTraits = false;
  if (classIndex !== undefined) {
    const classToken = tokens[classIndex];
    if (!/^[A-Za-z_]\w*$/.test(tokens[classIndex + 1]?.value ?? "")) unresolved = true;
    const open = tokens.findIndex((item, position) => position > classIndex && item.value === "{");
    const header = tokens.slice(classIndex + 2, open);
    const extendsIndex = header.findIndex(item => item.value.toLowerCase() === "extends");
    const parent = extendsIndex === -1 ? undefined : header[extendsIndex + 1]?.value;
    const parentIsModel = Boolean(parent &&
      resolveName(parent, namespace, imports) === "illuminate\\database\\eloquent\\model");
    if (!parentIsModel) {
      unresolved = true; // Do not guess traits or boot implementations inherited from custom parents.
    }
    const close = closingBrace(tokens, open);
    for (let index = open + 1; index < close; index++) {
      const token = tokens[index]!;
      if (token.value.toLowerCase() === "use") {
        let end = index + 1;
        while (end < close && ![";", "{"].includes(tokens[end]!.value)) end++;
        for (const item of tokens.slice(index + 1, end)) {
          if (item.value === ",") continue;
          if (resolveName(item.value, namespace, imports) === "app\\traits\\logtrait") hasLogTrait = true;
          else hasOtherTraits = true;
        }
        if (tokens[end]?.value === "{") { unresolved = true; end = closingBrace(tokens, end); }
        index = end;
      } else if (token.value.toLowerCase() === "function") {
        const nameIndex = tokens[index + 1]?.value === "&" ? index + 2 : index + 1;
        const methodName = tokens[nameIndex]?.value.toLowerCase();
        let bodyStart = nameIndex + 1;
        while (bodyStart < close && !["{", ";"].includes(tokens[bodyStart]!.value)) bodyStart++;
        const bodyEnd = tokens[bodyStart]?.value === "{" ? closingBrace(tokens, bodyStart) : bodyStart;
        const body = tokens.slice(bodyStart + 1, bodyEnd);
        if (methodName === "boot") {
          const callsParent = body.some((item, position) => item.value.toLowerCase() === "parent" &&
            body[position + 1]?.value === "::" && body[position + 2]?.value.toLowerCase() === "boot" &&
            body[position + 3]?.value === "(");
          if (!callsParent) add("MODEL_BOOT_PARENT_MISSING",
            parentIsModel && !lexical.unresolved ? "error" : "review", token,
            "boot() propio no contiene parent::boot(); revise el arranque convencional de los traits.");
        }
        if (methodName === "bootlogtrait" || methodName === "logbd") {
          add(methodName === "bootlogtrait" ? "LOGTRAIT_BOOT_OVERRIDE" : "LOGTRAIT_LOGBD_OVERRIDE",
            "review", token, `El modelo redefine ${tokens[nameIndex]!.value}(); revise el comportamiento de auditoría.`);
        }
        index = bodyEnd;
      } else if (token.value === "$logAttributes" || token.value === "$ignoreFields") {
        add("LOGTRAIT_UNSUPPORTED_FILTER_CONFIG", "warning", token,
          `${token.value} no configura exclusiones del LogTrait; no garantiza filtrado de campos sensibles.`);
      } else if (token.value === "{") {
        unresolved = true;
        index = closingBrace(tokens, index);
      }
    }
    if (hasOtherTraits) unresolved = true;
    if (!hasLogTrait && !unresolved) {
      add("LOGTRAIT_MISSING", mode === "new" ? "error" : "warning", classToken,
        mode === "new" ? "El modelo nuevo auditable debe incorporar App\\Traits\\LogTrait dentro de la clase." :
          "El modelo legado no incorpora LogTrait; revise su auditoría existente antes de modificarlo.");
    }
  }
  if (unresolved) {
    add("MODEL_AUDIT_UNRESOLVED", "review", classIndex === undefined ? undefined : tokens[classIndex],
      "El análisis limitado no resuelve toda la sintaxis, herencia o composición de traits; requiere revisión.");
  }
  const errors = findings.some(item => item.severity === "error");
  const review = findings.some(item => item.severity === "review" ||
    (item.rule === "LOGTRAIT_MISSING" && mode === "legacy"));
  return {
    status: errors ? "non_compliant" : review ? "needs_review" : "compliant",
    passed: errors ? false : review ? null : true,
    hasLogTrait,
    findings,
  };
}

export async function lintModelAudit(portalRoot: string, modelPath: string, mode: ModelAuditMode) {
  if (path.extname(modelPath).toLowerCase() !== ".php") throw new Error("El modelo debe ser un archivo .php.");
  const model = await readProjectSource(path.join(portalRoot, "backend"), modelPath);
  const context = await readLogTraitContext(portalRoot, "backend");
  const inspection = inspectModelAudit(model.text, mode);
  return {
    modelPath: model.path.replaceAll("\\", "/"),
    mode,
    verification: "static",
    ...inspection,
    manualReview: [
      "Aplicar la sección aprobada del estándar indicada en standard.resourceUri.",
      "Verificar identidad y validación de cabeceras en el endpoint y contexto de jobs/comandos.",
      "Revisar atributos sensibles; el resultado estático no certifica su filtrado.",
      "Revisar transacciones y manejo de fallos entre persistencia y auditoría.",
      "Revisar escrituras sin eventos y llamadas manuales duplicadas en servicios/consumidores.",
      "Una coincidencia textual con parent::boot() no prueba que se ejecute en todas las ramas.",
    ],
    standard: { resourceUri: context.resourceUri, policyMarkdown: context.policyMarkdown },
    sources: [describeSource(model.path, model.text), ...context.sources],
  };
}
