import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type DevelopmentLayer = "backend" | "frontend";
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const LOGTRAIT_RESOURCE_URIS = {
  backend: "portalv4://standards/backend/logtrait",
  frontend: "portalv4://standards/frontend/logtrait",
} as const;

const SECTION_TITLES = {
  backend: "Auditoría de modelos mediante LogTrait",
  frontend: "Contexto de auditoría en llamadas al backend",
} as const;

export interface SourceReference {
  path: string;
  startLine: number;
  endLine: number;
  /** SHA-256 of the returned section, not of the surrounding file. */
  sha256: string;
}

export function describeSource(filePath: string, text: string, startLine = 1): SourceReference {
  const lineCount = text.replace(/\r?\n$/, "").split(/\r?\n/).length;
  return {
    path: filePath.replaceAll("\\", "/"),
    startLine,
    endLine: startLine + lineCount - 1,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

/** Resolve symlinks before reading; never read outside the designated repository. */
export async function readProjectSource(root: string, filePath: string) {
  const resolvedRoot = await realpath(root);
  const resolvedPath = await realpath(path.resolve(resolvedRoot, filePath));
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("La fuente debe permanecer dentro del repositorio autorizado.");
  }
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile() || fileStat.size > MAX_SOURCE_BYTES) {
    throw new Error(`La fuente debe ser un archivo de hasta ${MAX_SOURCE_BYTES} bytes.`);
  }
  const bytes = await readFile(resolvedPath);
  if (bytes.length > MAX_SOURCE_BYTES) {
    throw new Error("La fuente excede el límite de tamaño.");
  }
  return { path: resolvedPath, text: bytes.toString("utf8") };
}

function extractSection(source: string, title: string) {
  const lines = source.split(/\r?\n/);
  const matches = lines.flatMap((line, index) => line === `### ${title}` ? [index] : []);
  if (matches.length !== 1) {
    throw new Error(`Se requiere exactamente una sección '### ${title}'.`);
  }
  const start = matches[0]!;
  let end = start + 1;
  while (end < lines.length && !/^#{1,3}\s/.test(lines[end]!)) end += 1;
  // Preserve internal wording and blank lines; normalize only line endings.
  const text = lines.slice(start, end).join("\n").trimEnd() + "\n";
  return { text, startLine: start + 1 };
}

export async function readLogTraitContext(portalRoot: string, layer: DevelopmentLayer) {
  const repositoryRoot = path.join(portalRoot, layer);
  const policyFile = await readProjectSource(repositoryRoot, ".github/copilot-instructions.md");
  const section = extractSection(policyFile.text, SECTION_TITLES[layer]);
  const traitFile = await readProjectSource(path.join(portalRoot, "backend"), "app/Traits/LogTrait.php");
  const policySource = describeSource(policyFile.path, section.text, section.startLine);
  const traitSource = describeSource(traitFile.path, traitFile.text);
  return {
    layer,
    resourceUri: LOGTRAIT_RESOURCE_URIS[layer],
    policyMarkdown: section.text,
    traitSource: traitFile.text,
    sources: [policySource, traitSource],
  };
}

export async function readLogTraitResource(portalRoot: string, layer: DevelopmentLayer) {
  const context = await readLogTraitContext(portalRoot, layer);
  return context.policyMarkdown + "\n### Fuente técnica actual: LogTrait.php\n\n```php\n" +
    context.traitSource.trimEnd() + "\n```\n\n### Fuentes verificables\n\n" +
    context.sources.map(source =>
      `- ${source.path}:${source.startLine}-${source.endLine}; SHA-256: ${source.sha256}`,
    ).join("\n") + "\n";
}
