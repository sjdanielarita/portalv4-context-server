#!/usr/bin/env node

import { execSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import sql from "mssql";
import { createConnection as createMysqlConnection } from "mysql2/promise";
import * as z from "zod/v4";

const SERVER_NAME = "portalv4-context-server";
const SERVER_VERSION = "0.1.0";
const DEFAULT_MAX_CONTROLLER_BYTES = 1024 * 1024;
const LARAVEL_BACKEND_PATH = "/home/sjdarita/proyectos/portalv4/backend";
const CONNECTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const PHP_CLASS_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
const LARAVEL_CONNECTION_CONFIG_SCRIPT = [
  `require "${LARAVEL_BACKEND_PATH}/vendor/autoload.php";`,
  `$app = require_once "${LARAVEL_BACKEND_PATH}/bootstrap/app.php";`,
  "$app->make(\\Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();",
  "$requested = $argv[1] ?? null;",
  "$name = $requested ?: config(\"database.default\");",
  "$connection = config(\"database.connections.\" . $name);",
  "if (!is_array($connection)) { fwrite(STDERR, \"Conexión desconocida.\"); exit(2); }",
  "echo json_encode([\"connection_name\" => $name, \"config\" => $connection], JSON_THROW_ON_ERROR);",
].join(" ");
const LARAVEL_CONNECTION_CONFIG_COMMAND =
  `php -r '${LARAVEL_CONNECTION_CONFIG_SCRIPT}'`;
const LARAVEL_ROUTE_LIST_SCRIPT = [
  `require "${LARAVEL_BACKEND_PATH}/vendor/autoload.php";`,
  `$app = require_once "${LARAVEL_BACKEND_PATH}/bootstrap/app.php";`,
  "$app->make(\\Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();",
  "$routes = [];",
  "foreach ($app->make(\"router\")->getRoutes() as $route) {",
  "$routes[] = [",
  "\"domain\" => $route->getDomain(),",
  "\"method\" => implode(\"|\", $route->methods()),",
  "\"uri\" => $route->uri(),",
  "\"name\" => $route->getName(),",
  "\"action\" => $route->getActionName(),",
  "\"middleware\" => array_values($route->gatherMiddleware()),",
  "];",
  "}",
  "echo json_encode($routes, JSON_THROW_ON_ERROR);",
].join(" ");
const LARAVEL_ROUTE_LIST_COMMAND = `php -r '${LARAVEL_ROUTE_LIST_SCRIPT}'`;
const READ_DATABASE_SCHEMA_DESCRIPTION =
  "Lee la estructura de una tabla (columnas, tipos de datos, llaves). Esta herramienta es " +
  "estrictamente de solo lectura. Está prohibido y es técnicamente imposible realizar " +
  "operaciones CREATE, UPDATE, DELETE o DROP a través de esta herramienta.";
const EXPORT_ENDPOINT_DOCS_DESCRIPTION =
  "Lee las rutas registradas en Laravel y exporta una colección en formato Postman Collection " +
  "v2.1.0 lista para ser importada en Hoppscotch o Postman.";
const GENERATE_TESTS_DESCRIPTION =
  "Genera el código base estandarizado para pruebas (Feature/Unit) en PortalV4. Garantiza el " +
  "uso estricto de DatabaseTransactions para proteger la base de datos de desarrollo. " +
  "PROHIBIDO usar RefreshDatabase.";
const REVIEW_QUALITY_AND_GIT_DESCRIPTION =
  "Audita la nomenclatura de la rama de Git y el mensaje de commit propuesto para garantizar " +
  "que cumplen con los estándares de la cooperativa (Conventional Commits y prefijos de rama).";
const POSTMAN_COLLECTION_SCHEMA_URL =
  "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";
const BRANCH_NAME_PATTERN =
  /^(?:feature|bugfix|hotfix|release|chore)\/[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;
const COMMIT_MESSAGE_PATTERN =
  /^(?:feat|fix|docs|refactor|test|chore|perf|build|ci|style|revert|module)(?:\([A-Za-z0-9._/-]+\))?!?: \S(?:.*\S)?$/;

const SQLSERVER_LIST_DATABASE_TABLES_QUERY = `
  SELECT
    TABLE_SCHEMA AS table_schema,
    TABLE_NAME AS table_name,
    TABLE_TYPE AS table_type
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_TYPE = 'BASE TABLE'
    AND TABLE_CATALOG = DB_NAME()
  ORDER BY TABLE_SCHEMA, TABLE_NAME;
`;

const SQLSERVER_READ_DATABASE_TABLE_SCHEMA_QUERY = `
  SELECT
    c.TABLE_SCHEMA AS table_schema,
    c.TABLE_NAME AS table_name,
    c.ORDINAL_POSITION AS ordinal_position,
    c.COLUMN_NAME AS column_name,
    c.DATA_TYPE AS data_type,
    c.CHARACTER_MAXIMUM_LENGTH AS maximum_length,
    c.IS_NULLABLE AS is_nullable,
    (
      SELECT TOP (1) tc.CONSTRAINT_TYPE
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS kcu
      INNER JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS tc
        ON tc.CONSTRAINT_CATALOG = kcu.CONSTRAINT_CATALOG
        AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      WHERE kcu.TABLE_CATALOG = c.TABLE_CATALOG
        AND kcu.TABLE_SCHEMA = c.TABLE_SCHEMA
        AND kcu.TABLE_NAME = c.TABLE_NAME
        AND kcu.COLUMN_NAME = c.COLUMN_NAME
        AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
      ORDER BY CASE tc.CONSTRAINT_TYPE
        WHEN 'PRIMARY KEY' THEN 1
        WHEN 'FOREIGN KEY' THEN 2
        ELSE 3
      END
    ) AS key_type
  FROM INFORMATION_SCHEMA.COLUMNS AS c
  WHERE c.TABLE_CATALOG = DB_NAME()
    AND c.TABLE_NAME = @tableName
  ORDER BY c.TABLE_SCHEMA, c.ORDINAL_POSITION;
`;

const MYSQL_LIST_DATABASE_TABLES_QUERY = `
  SELECT
    TABLE_SCHEMA AS table_schema,
    TABLE_NAME AS table_name,
    TABLE_TYPE AS table_type
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_TYPE = 'BASE TABLE'
    AND TABLE_SCHEMA = DATABASE()
  ORDER BY TABLE_SCHEMA, TABLE_NAME;
`;

const MYSQL_READ_DATABASE_TABLE_SCHEMA_QUERY = `
  SELECT
    c.TABLE_SCHEMA AS table_schema,
    c.TABLE_NAME AS table_name,
    c.ORDINAL_POSITION AS ordinal_position,
    c.COLUMN_NAME AS column_name,
    c.DATA_TYPE AS data_type,
    c.CHARACTER_MAXIMUM_LENGTH AS maximum_length,
    c.IS_NULLABLE AS is_nullable,
    (
      SELECT tc.CONSTRAINT_TYPE
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS kcu
      INNER JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS tc
        ON tc.CONSTRAINT_CATALOG = kcu.CONSTRAINT_CATALOG
        AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      WHERE kcu.TABLE_SCHEMA = c.TABLE_SCHEMA
        AND kcu.TABLE_NAME = c.TABLE_NAME
        AND kcu.COLUMN_NAME = c.COLUMN_NAME
        AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
      ORDER BY CASE tc.CONSTRAINT_TYPE
        WHEN 'PRIMARY KEY' THEN 1
        WHEN 'FOREIGN KEY' THEN 2
        ELSE 3
      END
      LIMIT 1
    ) AS key_type
  FROM INFORMATION_SCHEMA.COLUMNS AS c
  WHERE c.TABLE_SCHEMA = DATABASE()
    AND c.TABLE_NAME = ?
  ORDER BY c.ORDINAL_POSITION;
`;

type Architecture = "modules" | "classic";
type SupportedDatabaseDriver = "sqlsrv" | "mysql";
type TestType = "Feature" | "Unit";

interface PathDescriptor {
  absolutePath: string;
  portablePath: string;
  exists: boolean;
  kind: "directory" | "file";
}

interface LintFinding {
  rule: "ELOQUENT_STATIC_CALL" | "ELOQUENT_MUTATION" | "DB_FACADE_CALL";
  line: number;
  column: number;
  match: string;
  message: string;
}

interface LaravelDatabaseConfig {
  connectionName: string;
  driver: SupportedDatabaseDriver;
  settings: Record<string, unknown>;
}

interface LaravelRouteDefinition {
  domain: string | null;
  method: string;
  uri: string;
  name: string | null;
  action: string;
  middleware: string[];
}

interface PostmanItem {
  name: string;
  request?: Record<string, unknown>;
  response?: unknown[];
  item?: PostmanItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredDatabaseString(
  settings: Record<string, unknown>,
  name: string,
  allowEmpty = false,
): string {
  const value = settings[name];
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new Error(`La conexión Laravel no contiene un valor válido para '${name}'.`);
  }

  return value;
}

function optionalDatabaseString(
  settings: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = settings[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function databasePort(value: unknown, defaultPort: number): number {
  const port = typeof value === "number" ? value : Number.parseInt(String(value ?? defaultPort), 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("La conexión Laravel contiene un puerto TCP inválido.");
  }

  return port;
}

function parseDatabaseBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLocaleLowerCase();
  if (["true", "(true)", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "(false)", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error("La conexión Laravel contiene un valor booleano inválido.");
}

function loadLaravelDatabaseConfig(connectionName?: string): LaravelDatabaseConfig {
  if (connectionName !== undefined && !CONNECTION_NAME_PATTERN.test(connectionName)) {
    throw new Error("connection_name contiene caracteres no permitidos.");
  }

  let serializedConfig: string;
  try {
    const connectionArgument = connectionName === undefined ? "" : ` ${connectionName}`;
    serializedConfig = execSync(
      `${LARAVEL_CONNECTION_CONFIG_COMMAND}${connectionArgument}`,
      {
        cwd: LARAVEL_BACKEND_PATH,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      },
    ).trim();
  } catch {
    throw new Error(
      `Laravel no pudo resolver la conexión '${connectionName ?? "predeterminada"}'.`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(serializedConfig);
  } catch {
    throw new Error("Laravel devolvió una configuración de conexión inválida.");
  }

  if (!isRecord(payload) || typeof payload.connection_name !== "string" ||
      !isRecord(payload.config) || typeof payload.config.driver !== "string") {
    throw new Error("Laravel devolvió una configuración de conexión incompleta.");
  }

  if (payload.config.driver !== "sqlsrv" && payload.config.driver !== "mysql") {
    throw new Error(`El driver '${payload.config.driver}' no está soportado por esta herramienta.`);
  }

  return {
    connectionName: payload.connection_name,
    driver: payload.config.driver,
    settings: payload.config,
  };
}

function loadLaravelRoutes(): LaravelRouteDefinition[] {
  let serializedRoutes: string;
  try {
    serializedRoutes = execSync(LARAVEL_ROUTE_LIST_COMMAND, {
      cwd: LARAVEL_BACKEND_PATH,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  } catch {
    throw new Error("Laravel no pudo exportar la lista de rutas.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(serializedRoutes);
  } catch {
    throw new Error("Laravel devolvió una lista de rutas con JSON inválido.");
  }

  if (!Array.isArray(payload)) {
    throw new Error("Laravel devolvió una lista de rutas con formato inválido.");
  }

  return payload.map((route, index) => {
    if (!isRecord(route) || typeof route.method !== "string" ||
        typeof route.uri !== "string" || typeof route.action !== "string" ||
        !(route.name === null || typeof route.name === "string") ||
        !(route.domain === null || typeof route.domain === "string") ||
        !Array.isArray(route.middleware) ||
        !route.middleware.every((middleware) => typeof middleware === "string")) {
      throw new Error(`La ruta Laravel en la posición ${index} tiene un formato inválido.`);
    }

    return {
      domain: route.domain,
      method: route.method,
      uri: route.uri,
      name: route.name,
      action: route.action,
      middleware: route.middleware,
    };
  });
}

function postmanMethods(methods: string): string[] {
  const parsedMethods = methods
    .split("|")
    .map((method) => method.trim().toUpperCase())
    .filter((method) => method !== "" && method !== "HEAD" && method !== "OPTIONS");

  return parsedMethods.length > 0 ? parsedMethods : [methods.trim().toUpperCase()];
}

function postmanPath(uri: string): { path: string[]; variables: Array<Record<string, string>> } {
  const variables = [...uri.matchAll(/\{([^}/?]+)\??\}/g)].map((match) => ({
    key: match[1] ?? "parameter",
    value: "",
  }));
  const pathSegments = uri === "/"
    ? []
    : uri.split("/").filter(Boolean).map(
        (segment) => segment.replace(/\{([^}/?]+)\??\}/g, ":$1"),
      );

  return { path: pathSegments, variables };
}

function createPostmanRequest(route: LaravelRouteDefinition, method: string): PostmanItem {
  const { path: pathSegments, variables } = postmanPath(route.uri);
  const normalizedPath = pathSegments.join("/");
  const hasJsonBody = ["POST", "PUT", "PATCH"].includes(method);
  const headers: Array<Record<string, unknown>> = [
    { key: "Accept", value: "application/json", type: "text" },
    ...(hasJsonBody
      ? [{ key: "Content-Type", value: "application/json", type: "text" }]
      : []),
  ];
  const description = [
    route.name === null ? null : `Nombre Laravel: ${route.name}`,
    `Acción: ${route.action}`,
    route.domain === null ? null : `Dominio: ${route.domain}`,
    `Middleware: ${route.middleware.join(", ") || "ninguno"}`,
  ].filter((line): line is string => line !== null).join("\n");

  return {
    name: `${method} ${route.name ?? route.uri}`,
    request: {
      method,
      header: headers,
      description,
      url: {
        raw: normalizedPath === "" ? "{{base_url}}" : `{{base_url}}/${normalizedPath}`,
        host: ["{{base_url}}"],
        path: pathSegments,
        ...(variables.length === 0 ? {} : { variable: variables }),
      },
      ...(hasJsonBody
        ? {
            body: {
              mode: "raw",
              raw: "{}",
              options: { raw: { language: "json" } },
            },
          }
        : {}),
    },
    response: [],
  };
}

function exportEndpointDocs(prefix?: string): Record<string, unknown> {
  const normalizedPrefix = prefix?.trim().replace(/^\/+/, "") ?? "";
  const routes = loadLaravelRoutes().filter(
    (route) => normalizedPrefix === "" || route.uri.startsWith(normalizedPrefix),
  );
  const folders = new Map<string, PostmanItem[]>();

  for (const route of routes) {
    const folderName = route.uri.split("/").filter(Boolean)[0] ?? "root";
    const folderItems = folders.get(folderName) ?? [];
    for (const method of postmanMethods(route.method)) {
      folderItems.push(createPostmanRequest(route, method));
    }
    folders.set(folderName, folderItems);
  }

  const items: PostmanItem[] = [...folders.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, folderItems]) => ({
      name,
      item: folderItems.sort((left, right) => left.name.localeCompare(right.name)),
    }));

  return {
    info: {
      name: normalizedPrefix === ""
        ? "PortalV4 Backend API"
        : `PortalV4 Backend API - ${normalizedPrefix}`,
      description: normalizedPrefix === ""
        ? "Colección generada desde las rutas registradas en Laravel."
        : `Colección generada desde rutas Laravel con prefijo '${normalizedPrefix}'.`,
      schema: POSTMAN_COLLECTION_SCHEMA_URL,
    },
    variable: [
      { key: "base_url", value: "http://localhost", type: "string" },
    ],
    item: items,
  };
}

function generateTestTemplate(
  testName: string,
  type: TestType,
  moduleName?: string,
): string {
  const namespace = moduleName === undefined
    ? `Tests\\${type}`
    : `Modules\\${moduleName}\\Tests\\${type}`;

  return `<?php

namespace ${namespace};

use Illuminate\\Foundation\\Testing\\DatabaseTransactions;
use Tests\\TestCase;

class ${testName} extends TestCase
{
    use DatabaseTransactions;

    public function test_example()
    {
    }
}
`;
}

function suggestedCommitMessage(commitMessage: string): string {
  const normalizedMessage = commitMessage.trim();
  const type = /^(?:fix|bugfix|hotfix|correg|soluc)/i.test(normalizedMessage)
    ? "fix"
    : /^(?:docs?|document)/i.test(normalizedMessage)
      ? "docs"
      : /^refactor/i.test(normalizedMessage)
        ? "refactor"
        : /^(?:test|prueb)/i.test(normalizedMessage)
          ? "test"
          : /^(?:chore|manten)/i.test(normalizedMessage)
            ? "chore"
            : "feat";
  const existingDescription = normalizedMessage.match(/^[^:]+:\s*(.*)$/)?.[1];
  const description = (existingDescription ?? normalizedMessage)
    .replace(
      /^(?:feat|feature|fix|bugfix|hotfix|docs?|documentation|refactor|test|chore)\s*[-:]?\s*/i,
      "",
    )
    .trim() || "describir el cambio realizado";
  const normalizedDescription = description.charAt(0).toLocaleLowerCase() + description.slice(1);

  return `${type}: ${normalizedDescription}`;
}

function reviewQualityAndGit(
  branchName: string,
  commitMessage: string,
): Record<string, unknown> {
  const branchErrors: string[] = [];
  const commitErrors: string[] = [];
  const normalizedBranchName = branchName.trim();
  const normalizedCommitMessage = commitMessage.trim();

  if (branchName !== normalizedBranchName) {
    branchErrors.push("La rama no debe contener espacios al inicio o al final.");
  }
  if (!BRANCH_NAME_PATTERN.test(normalizedBranchName)) {
    branchErrors.push(
      "La rama debe comenzar con feature/, bugfix/, hotfix/, release/ o chore/ y contener un nombre válido.",
    );
  }

  if (commitMessage !== normalizedCommitMessage) {
    commitErrors.push("El mensaje de commit no debe contener espacios al inicio o al final.");
  }
  if (!COMMIT_MESSAGE_PATTERN.test(normalizedCommitMessage)) {
    commitErrors.push(
      "El commit debe usar Conventional Commits con el formato 'tipo: descripción'.",
    );
  }

  return {
    passed: branchErrors.length === 0 && commitErrors.length === 0,
    branch_errors: branchErrors,
    commit_errors: commitErrors,
    suggested_commit: commitErrors.length === 0
      ? ""
      : suggestedCommitMessage(normalizedCommitMessage),
  };
}

function isWslRuntime(): boolean {
  return process.platform === "linux" && (
    Boolean(process.env.WSL_DISTRO_NAME) ||
    os.release().toLowerCase().includes("microsoft")
  );
}

function trimWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function configuredWslDistro(): string | undefined {
  return process.env.PORTALV4_WSL_DISTRO ?? process.env.WSL_DISTRO_NAME;
}

function isCrossPlatformAbsolute(rawPath: string): boolean {
  const input = trimWrappingQuotes(rawPath);
  return input.startsWith("/") ||
    /^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(input) ||
    /^[a-z]:[\\/]/i.test(input) ||
    path.isAbsolute(input);
}

/** Convert a Windows, UNC/WSL or POSIX path into a path usable by this process. */
function toNativePath(rawPath: string): string {
  const input = trimWrappingQuotes(rawPath);
  if (!input) {
    throw new Error("La ruta no puede estar vacía.");
  }

  const uncWsl = input.match(
    /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\/]+)(?:[\\/](.*))?$/i,
  );
  const windowsDrive = input.match(/^([a-z]):[\\/](.*)$/i);

  if (process.platform === "win32") {
    if (uncWsl || windowsDrive || path.win32.isAbsolute(input)) {
      return path.win32.normalize(input.replaceAll("/", "\\"));
    }

    if (input.startsWith("/")) {
      const distro = configuredWslDistro();
      if (!distro) {
        throw new Error(
          "Una ruta POSIX ejecutada desde Windows requiere PORTALV4_WSL_DISTRO " +
          "(por ejemplo, Ubuntu-24.04), o una ruta UNC \\\\wsl.localhost\\...",
        );
      }

      return path.win32.normalize(
        `\\\\wsl.localhost\\${distro}${input.replaceAll("/", "\\")}`,
      );
    }

    return path.win32.resolve(input.replaceAll("/", "\\"));
  }

  if (uncWsl) {
    if (!isWslRuntime()) {
      throw new Error("Las rutas UNC de WSL sólo son traducibles dentro de WSL o Windows.");
    }

    const [, requestedDistro, rest = ""] = uncWsl;
    const currentDistro = process.env.WSL_DISTRO_NAME;
    if (
      currentDistro &&
      requestedDistro &&
      currentDistro.localeCompare(requestedDistro, undefined, { sensitivity: "accent" }) !== 0
    ) {
      throw new Error(
        `La ruta apunta a la distribución WSL '${requestedDistro}', pero el servidor ` +
        `se ejecuta en '${currentDistro}'.`,
      );
    }

    return path.posix.normalize(`/${rest.replaceAll("\\", "/")}`);
  }

  if (windowsDrive) {
    if (!isWslRuntime()) {
      throw new Error("Una ruta con unidad de Windows sólo es traducible desde WSL.");
    }

    const [, drive = "", rest = ""] = windowsDrive;
    return path.posix.normalize(`/mnt/${drive.toLowerCase()}/${rest.replaceAll("\\", "/")}`);
  }

  if (input.startsWith("/")) {
    return path.posix.normalize(input.replaceAll("\\", "/"));
  }

  return path.resolve(input.replaceAll("\\", path.sep).replaceAll("/", path.sep));
}

function toPortablePath(nativePath: string): string {
  return nativePath.replaceAll("\\", "/");
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function locatePortalRoot(): Promise<string> {
  const configured = process.env.PORTALV4_ROOT;
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const rawCandidates = configured
    ? [configured]
    : [process.cwd(), path.join(process.cwd(), "portalv4"), path.join(packageRoot, "portalv4")];

  for (const rawCandidate of rawCandidates) {
    const candidate = toNativePath(rawCandidate);
    if (
      await isDirectory(path.join(candidate, "backend")) &&
      await isDirectory(path.join(candidate, "frontend"))
    ) {
      return realpath(candidate);
    }
  }

  if (configured) {
    throw new Error(
      `PORTALV4_ROOT no contiene backend/ y frontend/: ${toPortablePath(toNativePath(configured))}`,
    );
  }

  throw new Error(
    "No se encontró PortalV4. Configure PORTALV4_ROOT con una ruta nativa, POSIX, " +
    "de Windows o UNC de WSL.",
  );
}

async function findChildCaseInsensitive(
  parent: string,
  requestedName: string,
): Promise<string | undefined> {
  if (!await isDirectory(parent)) {
    return undefined;
  }

  const entries = await readdir(parent, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  const exact = directories.find((entry) => entry.name === requestedName);
  if (exact) {
    return exact.name;
  }

  const matches = directories.filter(
    (entry) => entry.name.toLocaleLowerCase() === requestedName.toLocaleLowerCase(),
  );
  if (matches.length > 1) {
    throw new Error(`El nombre '${requestedName}' coincide con más de un directorio en ${parent}.`);
  }

  return matches[0]?.name;
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[ _]+/g, "-")
    .toLocaleLowerCase();
}

async function describePath(
  absolutePath: string,
  kind: "directory" | "file" = "directory",
): Promise<PathDescriptor> {
  return {
    absolutePath,
    portablePath: toPortablePath(absolutePath),
    exists: await exists(absolutePath),
    kind,
  };
}

async function describePathMap(
  paths: Record<string, { path: string; kind?: "directory" | "file" }>,
): Promise<Record<string, PathDescriptor>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([key, value]) => [
        key,
        await describePath(value.path, value.kind),
      ]),
    ),
  );
}

async function getModuleStructure(portalRoot: string, requestedName: string) {
  const backendRoot = path.join(portalRoot, "backend");
  const frontendRoot = path.join(portalRoot, "frontend");

  const [backendModuleName, frontendModuleName, backendClassicName, frontendClassicName] =
    await Promise.all([
      findChildCaseInsensitive(path.join(backendRoot, "Modules"), requestedName),
      findChildCaseInsensitive(path.join(frontendRoot, "Modules"), requestedName),
      findChildCaseInsensitive(path.join(backendRoot, "app", "Http", "Controllers"), requestedName),
      findChildCaseInsensitive(path.join(frontendRoot, "app", "Http", "Controllers"), requestedName),
    ]);

  const moduleName = backendModuleName ?? frontendModuleName ?? requestedName;
  const classicName = backendClassicName ?? frontendClassicName ?? requestedName;
  const modulesExists = Boolean(backendModuleName || frontendModuleName);
  const classicExists = Boolean(backendClassicName || frontendClassicName);
  const selectedArchitecture: Architecture = modulesExists || !classicExists ? "modules" : "classic";
  const selectedName = selectedArchitecture === "modules" ? moduleName : classicName;

  const moduleBackendBase = path.join(backendRoot, "Modules", selectedName);
  const moduleFrontendBase = path.join(frontendRoot, "Modules", selectedName);
  const classicBackendControllerBase = path.join(
    backendRoot,
    "app",
    "Http",
    "Controllers",
    selectedName,
  );
  const classicFrontendControllerBase = path.join(
    frontendRoot,
    "app",
    "Http",
    "Controllers",
    selectedName,
  );

  const destinations = selectedArchitecture === "modules"
    ? {
        backend: await describePathMap({
          moduleRoot: { path: moduleBackendBase },
          controllers: { path: path.join(moduleBackendBase, "Controllers") },
          requests: { path: path.join(moduleBackendBase, "Requests") },
          services: { path: path.join(moduleBackendBase, "Services") },
          models: { path: path.join(moduleBackendBase, "Models") },
          routes: { path: path.join(moduleBackendBase, "Routes") },
        }),
        frontend: await describePathMap({
          moduleRoot: { path: moduleFrontendBase },
          controllers: { path: path.join(moduleFrontendBase, "Http", "Controllers") },
          routes: { path: path.join(moduleFrontendBase, "Http", "Routes") },
          views: { path: path.join(moduleFrontendBase, "Resources", "views") },
          assets: { path: path.join(moduleFrontendBase, "Resources", "assets") },
        }),
      }
    : {
        backend: await describePathMap({
          controllers: { path: classicBackendControllerBase },
          requests: { path: path.join(backendRoot, "app", "Http", "Requests", selectedName) },
          services: { path: path.join(backendRoot, "app", "Services", selectedName) },
          modelsByDatabase: { path: path.join(backendRoot, "app", "Models") },
          apiRoutes: { path: path.join(backendRoot, "routes", "api.php"), kind: "file" },
        }),
        frontend: await describePathMap({
          controllers: { path: classicFrontendControllerBase },
          views: {
            path: path.join(frontendRoot, "resources", "views", toKebabCase(selectedName)),
          },
          webRoutes: { path: path.join(frontendRoot, "routes", "web.php"), kind: "file" },
        }),
      };

  return {
    requestedModule: requestedName,
    canonicalModule: selectedName,
    selectedArchitecture,
    detected: {
      modules: modulesExists,
      classic: classicExists,
      coexist: modulesExists && classicExists,
      backendModules: Boolean(backendModuleName),
      frontendModules: Boolean(frontendModuleName),
      backendClassic: Boolean(backendClassicName),
      frontendClassic: Boolean(frontendClassicName),
    },
    selectionReason: modulesExists
      ? "Se detectó Modules; tiene prioridad absoluta."
      : classicExists
        ? "Sólo se detectó la arquitectura clásica; se conserva para evitar una refactorización implícita."
        : "El módulo no existe todavía; el código nuevo debe crearse en Modules.",
    destinations,
    notes: selectedArchitecture === "modules"
      ? [
          "Backend: API, validación, Service y persistencia; nunca vistas.",
          "Frontend: consumo de API y presentación; nunca Eloquent/DB.",
          "Thin Controller obligatorio: Controller -> FormRequest/Validator -> Service -> Model/DB.",
        ]
      : [
          "Respete la organización legacy existente; no migre a Modules implícitamente.",
          "modelsByDatabase apunta a la raíz porque los modelos clásicos se agrupan por base de datos.",
        ],
  };
}

/** Replace comments and quoted strings with spaces, preserving offsets and line breaks. */
function maskPhpCommentsAndStrings(source: string): string {
  const chars = [...source];
  let state: "code" | "single" | "double" | "lineComment" | "blockComment" = "code";

  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index] ?? "";
    const next = chars[index + 1] ?? "";

    if (state === "code") {
      if (current === "'") {
        chars[index] = " ";
        state = "single";
      } else if (current === '"') {
        chars[index] = " ";
        state = "double";
      } else if (current === "/" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        state = "lineComment";
      } else if (current === "#") {
        chars[index] = " ";
        state = "lineComment";
      } else if (current === "/" && next === "*") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        state = "blockComment";
      }
      continue;
    }

    if (state === "lineComment") {
      if (current === "\n") {
        state = "code";
      } else {
        chars[index] = " ";
      }
      continue;
    }

    if (state === "blockComment") {
      if (current === "*" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        state = "code";
      } else if (current !== "\n" && current !== "\r") {
        chars[index] = " ";
      }
      continue;
    }

    if (current === "\\") {
      chars[index] = " ";
      if (index + 1 < chars.length && chars[index + 1] !== "\n") {
        chars[index + 1] = " ";
        index += 1;
      }
      continue;
    }

    const closingQuote = state === "single" ? "'" : '"';
    if (current === closingQuote) {
      chars[index] = " ";
      state = "code";
    } else if (current !== "\n" && current !== "\r") {
      chars[index] = " ";
    }
  }

  return chars.join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  const preceding = source.slice(0, offset);
  const lines = preceding.split(/\r?\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function collectRegexFindings(
  source: string,
  regex: RegExp,
  rule: LintFinding["rule"],
  message: string,
): LintFinding[] {
  return [...source.matchAll(regex)].map((match) => ({
    rule,
    ...lineAndColumn(source, match.index),
    match: match[0].trim(),
    message,
  }));
}

function lintThinController(source: string): LintFinding[] {
  const masked = maskPhpCommentsAndStrings(source);
  const importedModels = new Set<string>();
  const modelImport = /^\s*use\s+\\?(?:App\\Models|Modules\\[^;\r\n]+\\Models)\\[^;\r\n]+?(?:\s+as\s+(\w+))?\s*;/gim;

  for (const match of masked.matchAll(modelImport)) {
    const statement = match[0].replace(/^\s*use\s+/i, "").replace(/\s*;\s*$/, "");
    const [fqcn = "", alias] = statement.split(/\s+as\s+/i);
    const localName = alias ?? fqcn.split("\\").at(-1);
    if (localName) {
      importedModels.add(localName.trim());
    }
  }

  const findings: LintFinding[] = [];
  for (const modelName of importedModels) {
    findings.push(...collectRegexFindings(
      masked,
      new RegExp(`\\b${escapeRegExp(modelName)}\\s*::\\s*[A-Za-z_]\\w*\\s*\\(`, "g"),
      "ELOQUENT_STATIC_CALL",
      `La llamada estática a ${modelName} debe moverse a un Service.`,
    ));
  }

  findings.push(...collectRegexFindings(
    masked,
    /(?:\\?(?:App\\Models|Modules\\[^\s;()]+\\Models)\\[^\s;()]+|\bModels\\[A-Z][\w\\]*)\s*::\s*[A-Za-z_]\w*\s*\(/g,
    "ELOQUENT_STATIC_CALL",
    "La llamada directa al modelo debe moverse a un Service.",
  ));
  findings.push(...collectRegexFindings(
    masked,
    /->\s*(?:save|saveOrFail|update|updateOrFail|delete|forceDelete|restore|increment|decrement|touch|push)\s*\(/g,
    "ELOQUENT_MUTATION",
    "La mutación/persistencia directa debe delegarse a un Service.",
  ));
  findings.push(...collectRegexFindings(
    masked,
    /\bDB\s*::\s*[A-Za-z_]\w*\s*\(/g,
    "DB_FACADE_CALL",
    "El acceso directo mediante DB debe moverse a un Service.",
  ));

  return [...new Map(
    findings.map((finding) => [
      `${finding.rule}:${finding.line}:${finding.column}:${finding.match}`,
      finding,
    ]),
  ).values()].sort((left, right) => left.line - right.line || left.column - right.column);
}

async function resolveControllerPath(portalRoot: string, rawControllerPath: string): Promise<string> {
  const backendRoot = await realpath(path.join(portalRoot, "backend"));
  const absolutePath = isCrossPlatformAbsolute(rawControllerPath)
    ? toNativePath(rawControllerPath)
    : path.resolve(
        backendRoot,
        trimWrappingQuotes(rawControllerPath)
          .replaceAll("\\", path.sep)
          .replaceAll("/", path.sep),
      );

  if (path.extname(absolutePath).toLocaleLowerCase() !== ".php") {
    throw new Error("El controlador debe ser un archivo .php.");
  }

  const resolvedPath = await realpath(absolutePath).catch(() => {
    throw new Error(`El controlador no existe o no es accesible: ${toPortablePath(absolutePath)}`);
  });
  if (!isInside(backendRoot, resolvedPath)) {
    throw new Error("El controlador debe estar dentro de portalv4/backend.");
  }

  return resolvedPath;
}

function asToolResult(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function asTextToolResult(content: string) {
  return {
    content: [{ type: "text" as const, text: content }],
  };
}

async function readSqlServerSchema(
  databaseConfig: LaravelDatabaseConfig,
  tableName: string,
): Promise<Record<string, unknown>> {
  const { settings } = databaseConfig;
  const pool = new sql.ConnectionPool({
    server: requiredDatabaseString(settings, "host"),
    port: databasePort(settings.port, 1433),
    database: requiredDatabaseString(settings, "database"),
    user: requiredDatabaseString(settings, "username"),
    password: requiredDatabaseString(settings, "password", true),
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
    pool: { min: 0, max: 1, idleTimeoutMillis: 1_000 },
    options: {
      encrypt: parseDatabaseBoolean(settings.encrypt, true),
      trustServerCertificate: parseDatabaseBoolean(settings.trust_server_certificate, false),
    },
  });

  try {
    await pool.connect();

    if (tableName === "") {
      const result = await pool.request().query(SQLSERVER_LIST_DATABASE_TABLES_QUERY);

      return {
        connectionName: databaseConfig.connectionName,
        driver: databaseConfig.driver,
        mode: "tables",
        tableCount: result.recordset.length,
        tables: result.recordset,
      };
    }

    const result = await pool
      .request()
      .input("tableName", sql.NVarChar(128), tableName)
      .query(SQLSERVER_READ_DATABASE_TABLE_SCHEMA_QUERY);

    return {
      connectionName: databaseConfig.connectionName,
      driver: databaseConfig.driver,
      mode: "columns",
      tableName,
      columnCount: result.recordset.length,
      columns: result.recordset,
    };
  } finally {
    await pool.close();
  }
}

async function readMysqlSchema(
  databaseConfig: LaravelDatabaseConfig,
  tableName: string,
): Promise<Record<string, unknown>> {
  const { settings } = databaseConfig;
  const socketPath = optionalDatabaseString(settings, "unix_socket");
  const charset = optionalDatabaseString(settings, "charset");
  const connection = await createMysqlConnection({
    host: requiredDatabaseString(settings, "host"),
    port: databasePort(settings.port, 3306),
    database: requiredDatabaseString(settings, "database"),
    user: requiredDatabaseString(settings, "username"),
    password: requiredDatabaseString(settings, "password", true),
    connectTimeout: 15_000,
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(charset === undefined ? {} : { charset }),
  });

  try {
    if (tableName === "") {
      const [rows] = await connection.execute(MYSQL_LIST_DATABASE_TABLES_QUERY);
      const tables = Array.isArray(rows) ? rows : [];

      return {
        connectionName: databaseConfig.connectionName,
        driver: databaseConfig.driver,
        mode: "tables",
        tableCount: tables.length,
        tables,
      };
    }

    const [rows] = await connection.execute(
      MYSQL_READ_DATABASE_TABLE_SCHEMA_QUERY,
      [tableName],
    );
    const columns = Array.isArray(rows) ? rows : [];

    return {
      connectionName: databaseConfig.connectionName,
      driver: databaseConfig.driver,
      mode: "columns",
      tableName,
      columnCount: columns.length,
      columns,
    };
  } finally {
    await connection.end();
  }
}

async function readDatabaseSchema(
  tableName: string,
  connectionName?: string,
): Promise<Record<string, unknown>> {
  const databaseConfig = loadLaravelDatabaseConfig(connectionName);
  const normalizedTableName = tableName.trim();

  return databaseConfig.driver === "sqlsrv"
    ? readSqlServerSchema(databaseConfig, normalizedTableName)
    : readMysqlSchema(databaseConfig, normalizedTableName);
}

function createServer(portalRoot: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Use get_module_structure antes de generar archivos. Para controladores backend nuevos, " +
        "use lint_thin_controller y no considere terminado el trabajo si passed=false.",
    },
  );

  server.registerTool(
    "get_module_structure",
    {
      title: "Obtener estructura de módulo PortalV4",
      description:
        "Detecta Modules y arquitectura clásica, aplica prioridad a Modules y devuelve destinos " +
        "absolutos utilizables desde el sistema operativo que ejecuta el servidor.",
      inputSchema: z.object({
        moduleName: z
          .string()
          .regex(/^[A-Z][A-Za-z0-9]*$/, "Use PascalCase y un solo segmento, sin barras ni '..'.")
          .describe("Nombre del módulo, por ejemplo WebCoosajo o AdministracionCarteras."),
      }),
    },
    async ({ moduleName }) => {
      try {
        return asToolResult(await getModuleStructure(portalRoot, moduleName));
      } catch (error) {
        return asToolResult({
          error: error instanceof Error ? error.message : String(error),
        }, true);
      }
    },
  );

  server.registerTool(
    "lint_thin_controller",
    {
      title: "Validar Thin Controller",
      description:
        "Analiza un controlador PHP dentro de portalv4/backend y rechaza llamadas directas a " +
        "modelos Eloquent, métodos de persistencia y la fachada DB.",
      inputSchema: z.object({
        controllerPath: z
          .string()
          .min(1)
          .describe("Ruta absoluta POSIX, Windows o UNC/WSL; también admite ruta relativa a backend."),
      }),
    },
    async ({ controllerPath }) => {
      try {
        const resolvedPath = await resolveControllerPath(portalRoot, controllerPath);
        const fileStat = await stat(resolvedPath);
        const maxBytes = Number.parseInt(
          process.env.PORTALV4_MAX_CONTROLLER_BYTES ?? String(DEFAULT_MAX_CONTROLLER_BYTES),
          10,
        );
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
          throw new Error("PORTALV4_MAX_CONTROLLER_BYTES debe ser un entero positivo.");
        }
        if (fileStat.size > maxBytes) {
          throw new Error(`El controlador excede el límite de ${maxBytes} bytes.`);
        }

        const source = await readFile(resolvedPath, "utf8");
        const findings = lintThinController(source);
        return asToolResult({
          controllerPath: resolvedPath,
          portablePath: toPortablePath(resolvedPath),
          passed: findings.length === 0,
          findingCount: findings.length,
          findings,
          requiredAction: findings.length === 0
            ? null
            : "Mueva las llamadas detectadas a un Service e inyecte ese Service en el controlador.",
        });
      } catch (error) {
        return asToolResult({
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        }, true);
      }
    },
  );

  server.registerTool(
    "read_database_schema",
    {
      title: "Leer esquema de base de datos",
      description: READ_DATABASE_SCHEMA_DESCRIPTION,
      inputSchema: z.object({
        table_name: z
          .string()
          .max(128)
          .describe("Nombre de la tabla; una cadena vacía devuelve todas las tablas disponibles."),
        connection_name: z
          .string()
          .regex(CONNECTION_NAME_PATTERN, "Use únicamente letras, números, guion o guion bajo.")
          .optional()
          .describe("Conexión definida en Laravel; si se omite, usa database.default."),
      }).strict(),
    },
    async ({ table_name, connection_name }) => {
      try {
        return asToolResult(await readDatabaseSchema(table_name, connection_name));
      } catch (error) {
        return asToolResult({
          error: error instanceof Error ? error.message : String(error),
        }, true);
      }
    },
  );

  server.registerTool(
    "export_endpoint_docs",
    {
      title: "Exportar documentación de endpoints",
      description: EXPORT_ENDPOINT_DOCS_DESCRIPTION,
      inputSchema: z.object({
        prefix: z
          .string()
          .max(255)
          .optional()
          .describe("Prefijo opcional para filtrar rutas, por ejemplo 'api/'."),
      }).strict(),
    },
    async ({ prefix }) => {
      try {
        return asToolResult(exportEndpointDocs(prefix));
      } catch (error) {
        return asToolResult({
          error: error instanceof Error ? error.message : String(error),
        }, true);
      }
    },
  );

  server.registerTool(
    "generate_tests",
    {
      title: "Generar plantilla de pruebas PortalV4",
      description: GENERATE_TESTS_DESCRIPTION,
      inputSchema: z.object({
        test_name: z
          .string()
          .regex(PHP_CLASS_NAME_PATTERN, "Use PascalCase y un nombre de clase PHP válido.")
          .describe("Nombre de la clase de prueba, por ejemplo BeneficioControllerTest."),
        type: z
          .enum(["Feature", "Unit"])
          .describe("Tipo de prueba que determina el namespace de destino."),
        module_name: z
          .string()
          .regex(PHP_CLASS_NAME_PATTERN, "Use PascalCase y un nombre de módulo válido.")
          .optional()
          .describe("Nombre opcional del módulo de la nueva arquitectura."),
      }).strict(),
    },
    async ({ test_name, type, module_name }) =>
      asTextToolResult(generateTestTemplate(test_name, type, module_name)),
  );

  server.registerTool(
    "review_quality_and_git",
    {
      title: "Auditar calidad de rama y commit",
      description: REVIEW_QUALITY_AND_GIT_DESCRIPTION,
      inputSchema: z.object({
        branch_name: z
          .string()
          .min(1)
          .describe("Nombre de la rama, por ejemplo feature/MejorasWeb."),
        commit_message: z
          .string()
          .min(1)
          .describe("Mensaje de commit propuesto."),
      }).strict(),
    },
    async ({ branch_name, commit_message }) =>
      asToolResult(reviewQualityAndGit(branch_name, commit_message)),
  );

  return server;
}

async function main(): Promise<void> {
  const portalRoot = await locatePortalRoot();
  console.error(`[${SERVER_NAME}] PortalV4: ${toPortablePath(portalRoot)}`);
  serveStdio(() => createServer(portalRoot));
}

main().catch((error: unknown) => {
  console.error(`[${SERVER_NAME}] Error fatal:`, error);
  process.exitCode = 1;
});
