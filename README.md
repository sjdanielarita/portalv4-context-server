# 🛡️ PortalV4 Context Server (MCP) - Manual Oficial

**Versión:** 1.0.0
**Entorno:** Híbrido (Windows / WSL2)
**Gestor de paquetes:** `pnpm`
**Transporte:** `stdio`

## 📖 Introducción
El `portalv4-context-server` es un microservicio basado en el estándar **Model Context Protocol (MCP)**. Actúa como el "gobierno técnico" del proyecto PortalV4. Su propósito principal es dotar a los agentes de Inteligencia Artificial (Cursor, Codex, Claude Code) de herramientas seguras para leer el contexto real del proyecto, validar reglas de arquitectura y prevenir código destructivo o fuera de estándar.

---

## 🤖 Sección para Agentes de IA (Instrucciones)

**ATENCIÓN IA:** Este servidor te proporciona capacidades de lectura y validación sobre el entorno real del usuario.
* **PROHIBIDO** adivinar rutas, esquemas de base de datos o inventar plantillas de tests.
* **OBLIGATORIO** invocar las herramientas documentadas en este manual antes de generar o proponer código al desarrollador.
* Tienes permiso implícito para usar estas herramientas de forma autónoma durante tu proceso de razonamiento.

---

## 🛠️ Catálogo de Herramientas (Skills)

El servidor expone 8 herramientas especializadas divididas por responsabilidades:

### 1. `get_module_structure` (Backend & Frontend)
**Propósito:** Garantizar el cumplimiento de la arquitectura modular desacoplada.
* **Qué hace:** Verifica si un módulo existe en la arquitectura clásica o en la nueva arquitectura `Modules`. Busca el nombre sin depender de mayúsculas/minúsculas y devuelve el nombre real del disco.
* **Payload exacto:** `{ "moduleName": "WebCoosajo" }`
* **Salida:** Destinos que incluyen ruta nativa absoluta, ruta portable con `/`, tipo y existencia actual. `developmentStandards` referencia el resource y la llamada a `get_logtrait_context` de cada capa.

### 2. `lint_thin_controller` (Solo Backend)
**Propósito:** Forzar el patrón *Thin Controller*.
* **Qué hace:** Analiza estáticamente archivos PHP dentro de `portalv4/backend`. Es un guardrail regex que detecta llamadas estáticas a modelos, mutaciones como `->save()` y `->update()`, y acceso directo mediante `DB::`.
* **Payload exacto:** `{ "controllerPath": "/ruta/absoluta/Controller.php" }`
* **Salida:** Devuelve `passed: false`, ubicación y acción requerida cuando hay hallazgos.

### 3. `read_database_schema` (Solo Backend)
**Propósito:** Eliminar alucinaciones de SQL y proteger el esquema de la base de datos.
* **Qué hace:** Levanta un proceso PHP en segundo plano, lee la conexión real desde `config/database.php` de Laravel y ejecuta una consulta de solo lectura (`INFORMATION_SCHEMA`) al motor (SQL Server o MySQL).
* **Payload exacto:** `{ "table_name": "Agencia", "connection_name": "sqlsrv" }` *(Nota: `connection_name` es opcional. Si `table_name` se deja vacía `""`, lista todas las tablas disponibles).*

### 4. `export_endpoint_docs` (Solo Backend)
**Propósito:** Automatizar la documentación de la API.
* **Qué hace:** Lee las rutas registradas en memoria en Laravel, realiza un análisis estático de los FormRequests y métodos para extraer parámetros obligatorios (`_Colaborador`, `_Token`), y escribe una colección **Postman Collection v2.1.0** exclusivamente en el archivo `.json` indicado por el usuario. También inyecta automáticamente variables de URL y encabezados como `Authorization: Bearer {{token}}`. No existe una ruta de salida predeterminada; el directorio padre debe existir y los enlaces simbólicos existentes se rechazan. Tampoco sobrescribe un archivo salvo autorización expresa.
* **Filtros Granulares:** Permite filtrar las rutas a documentar a través de los siguientes parámetros opcionales:
  * `prefix`: Filtra por prefijo de URL (ej. `api/`).
  * `module`: Filtra por el nombre del módulo de la arquitectura (ej. `WebCoosajo`).
  * `route_file`: Filtra por archivo de registro de ruta (ej. `api.php`).
  * `search_pattern`: Regex para filtrar por URI, nombre de ruta o controlador.
* **Payload exacto:** `{ "output_path": "/ruta/elegida/portalv4-api.json", "prefix": "api/", "module": "WebCoosajo", "overwrite": false }` *(Nota: `output_path` es obligatorio, absoluto y debe terminar en `.json`; los filtros y `overwrite` son opcionales. Para reemplazar un archivo existente, el usuario debe indicar `overwrite: true` expresamente).*
* **Salida:** Metadatos de la exportación: ruta efectiva, prefijo, cantidad de rutas y requests, bytes escritos y formato. La colección completa queda únicamente en `output_path`.

### 5. `generate_tests` (Solo Backend)
**Propósito:** Proteger la base de datos de desarrollo frente a ejecuciones de tests destructivos.
* **Qué hace:** Genera la plantilla base PHP para pruebas automatizadas garantizando la importación y uso estricto del trait `DatabaseTransactions` (prohibiendo `RefreshDatabase`).
* **Payload exacto:** `{ "test_name": "BeneficioControllerTest", "type": "Feature", "module_name": "WebCoosajo" }` *(Nota: `module_name` es opcional).*

### 6. `review_quality_and_git` (Backend & Frontend)
**Propósito:** Auditar de forma analítica y segura el control de versiones sin alterar Git.
* **Qué hace:** Inspecciona automática y pasivamente los repositorios reales `backend/` y `frontend/` bajo `PORTALV4_ROOT`. Ejecuta exclusivamente `git status --porcelain`, `git rev-parse --abbrev-ref HEAD` y `git diff --stat` con bloqueos opcionales desactivados. A partir de esa evidencia propone, cuando corresponde, un nombre de rama válido y un mensaje bajo *Conventional Commits* acorde con los archivos modificados.
* **Payload:** `{}`. No recibe nombres de rama ni mensajes redactados por el usuario; los campos heredados que un cliente antiguo envíe son ignorados.
* **Salida:** Reporte JSON por repositorio con rama actual, cumplimiento del estándar, estado *porcelain*, archivos cambiados, resumen del diff, observaciones y sugerencias. La herramienta nunca ejecuta `git add`, `git commit`, `git push`, `git merge` ni ninguna otra operación de escritura o alteración.

### 7. `get_logtrait_context` (Backend & Frontend)
**Propósito:** Consultar el estándar aprobado de auditoría antes de desarrollar.
* **Payload exacto:** `{ "layer": "backend" }` o `{ "layer": "frontend" }`. `layer` es obligatorio; no acepta campos adicionales.
* **Qué hace:** Lee en cada llamada la sección `Auditoría de modelos mediante LogTrait` del backend o `Contexto de auditoría en llamadas al backend` del frontend desde `.github/copilot-instructions.md`, junto con `backend/app/Traits/LogTrait.php`. Estas instrucciones son la única fuente del texto normativo; no existe una copia de respaldo en el MCP.
* **Salida:** `layer`, `resourceUri`, `policyMarkdown`, `traitSource` y `sources`. Cada fuente incluye `path`, `startLine`, `endLine` y `sha256` del texto devuelto. Se normalizan a LF los saltos de línea de la sección Markdown.
* **Límites:** Sólo lee archivos dentro de la capa correspondiente, después de resolver enlaces simbólicos; cada archivo admite hasta 1 MiB. Si falta un archivo o la sección requerida no es única, devuelve un error MCP explícito. No escribe archivos ni consulta la base de datos.

### 8. `lint_model_audit` (Solo Backend)
**Propósito:** Comprobar estáticamente la incorporación de LogTrait en un modelo de negocio con operaciones de escritura.
* **Payload exacto:** `{ "modelPath": "Modules/AdministracionCarteras/Models/Perfil.php", "mode": "new" }`. Ambos campos son obligatorios; `mode` admite `new` y `legacy`. También acepta rutas absolutas y rutas Windows/WSL mediante la normalización del servidor.
* **Qué hace:** Lee un PHP existente dentro del backend, hasta 1 MiB, y analiza declaraciones de clase, importaciones, uso del trait y métodos relevantes. No carga clases, no arranca Laravel, no ejecuta PHP y no corrige archivos.
* **Salida:** `modelPath`, `mode`, `verification: "static"`, `status`, `passed`, `hasLogTrait`, `findings`, `manualReview`, `standard` y `sources`. `hasLogTrait` indica uso directo reconocido; no certifica su ausencia en herencia/composición no resuelta. Los hallazgos incluyen regla, severidad, línea, columna y explicación, sin copiar valores del modelo.

| Regla | Resultado |
| --- | --- |
| `LOGTRAIT_MISSING` | Error en `new`; advertencia y revisión en `legacy`, preservando la auditoría existente. |
| `MODEL_BOOT_PARENT_MISSING` | `boot()` propio omite `parent::boot()`: error con padre Eloquent directo y análisis léxico resuelto; revisión en los demás casos. |
| `LOGTRAIT_BOOT_OVERRIDE` | Requiere revisar la redefinición de `bootLogTrait()`. |
| `LOGTRAIT_LOGBD_OVERRIDE` | Requiere revisar la redefinición de `LogBD()`. |
| `LOGTRAIT_UNSUPPORTED_FILTER_CONFIG` | Advierte que `$logAttributes`/`$ignoreFields` no configuran exclusiones de LogTrait. |
| `MODEL_AUDIT_UNRESOLVED` | El análisis limitado no resuelve sintaxis, herencia o composición; requiere revisión. |

* `status: "compliant"`, `passed: true`: superó las comprobaciones estáticas aplicables.
* `status: "non_compliant"`, `passed: false`: existe una infracción determinista.
* `status: "needs_review"`, `passed: null`: no se puede aprobar con este análisis o falta el trait en un modelo legado. Si también existe un error determinista, prevalece `non_compliant`.
* **Alcance del analizador:** Reconoce clases con herencia directa de `Illuminate\Database\Eloquent\Model`, importaciones simples y múltiples con alias, y uso directo o plenamente calificado de `App\Traits\LogTrait`. Ignora comentarios y literales. Importaciones agrupadas, atributos PHP, heredoc/nowdoc, padres personalizados, otros traits o adaptaciones requieren revisión; no se infiere su comportamiento. No sustituye un parser PHP completo ni una prueba de ejecución.
* **Revisión manual obligatoria:** Verificar el contexto/validación de cabeceras, atributos sensibles, transacciones entre conexiones, escrituras sin eventos y registros manuales duplicados. Una coincidencia con `parent::boot()` tampoco demuestra su ejecución en todas las ramas. `passed: true` no garantiza auditoría completa en ejecución.

## Resources del estándar LogTrait

| URI fija | Contenido |
| --- | --- |
| `portalv4://standards/backend/logtrait` | Sección aprobada de backend, fuente actual de LogTrait y referencias verificables. |
| `portalv4://standards/frontend/logtrait` | Sección aprobada de frontend, fuente actual de LogTrait y referencias verificables. |

Ambos resources usan `text/markdown` y leen los archivos en cada consulta, sin caché del estándar. Comparten la implementación de `get_logtrait_context`. No se agregan prompts ni plantillas de resources.

### Flujo de desarrollo

1. Consultar `get_module_structure` para determinar los destinos reales.
2. Consultar `get_logtrait_context` para la capa correspondiente, o leer su resource.
3. Para un modelo backend nuevo auditable, ejecutar `lint_model_audit` con `mode: "new"`; no concluir la verificación estática si `passed` no es `true`.
4. Atender `manualReview` y las verificaciones de controlador y Git que correspondan.

### Deuda técnica: cabeceras en `export_endpoint_docs`

El análisis actual puede clasificar `_Colaborador` y `_Token` como campos del cuerpo por presencia textual y no incorpora las cabeceras institucionales desde `analysis.requiredHeaders`. LogTrait obtiene la identidad de cabeceras HTTP. Queda pendiente distinguir cuerpo y cabeceras según evidencia del endpoint y middleware, sin agregarlas indiscriminadamente a todas las rutas. Esta integración no modifica el exportador.

---

## 👨‍💻 Sección para Desarrolladores Humanos

### Requisitos Previos
* **Node.js**: v20 o superior.
* **Gestor de paquetes**: `pnpm` v11+ (Requerido por `pnpm-workspace.yaml`).
* Una copia accesible de PortalV4 con los directorios `backend/` y `frontend/`.

### Variables de Entorno

| Variable | Uso |
| --- | --- |
| `PORTALV4_ROOT` | Raíz de PortalV4. Si se omite, se buscan `backend/` y `frontend/` desde el directorio actual y rutas vecinas. |
| `PORTALV4_WSL_DISTRO` | Distribución usada para traducir `/home/...` a `\\wsl.localhost\...` cuando Node corre en Windows (ej. `Ubuntu-24.04`). |
| `PORTALV4_MAX_CONTROLLER_BYTES` | Tamaño máximo del controlador analizado; predeterminado: 1 MiB. |

### Instalación y Desarrollo
El servidor MCP no se ejecuta en tiempo de ejecución de TypeScript, debe compilarse previamente. El transporte `stdio` reserva `stdout` para MCP; cualquier diagnóstico debe escribirse a `stderr`.

```bash
# Instalación y validación
pnpm install
pnpm check

# Compilar TypeScript a JavaScript (Genera dist/index.js)
pnpm build

La opción más estable es ejecutar el servidor en el mismo entorno donde vive el código:
Bash

PORTALV4_ROOT=/home/sjdarita/proyectos/portalv4 pnpm start

Ejemplos de Configuración de Clientes MCP
Use rutas y variables nativas del proceso que lanza Node.
Cliente ejecutado en WSL (Codex / Claude Code)
JSON

{
  "mcpServers": {
    "portalv4-context": {
      "command": "node",
      "args": [
        "/home/sjdarita/proyectos/portalv4-context-server/dist/index.js"
      ],
      "env": {
        "PORTALV4_ROOT": "/home/sjdarita/proyectos/portalv4"
      }
    }
  }
}

Cliente ejecutado en Windows, código dentro de WSL (Cursor / VS Code)
JSON

{
  "mcpServers": {
    "portalv4-context": {
      "command": "node",
      "args": [
        "\\\\wsl.localhost\\Ubuntu-24.04\\home\\sjdarita\\proyectos\\portalv4-context-server\\dist\\index.js"
      ],
      "env": {
        "PORTALV4_ROOT": "\\\\wsl.localhost\\Ubuntu-24.04\\home\\sjdarita\\proyectos\\portalv4"
      }
    }
  }
}

	Nota para Windows: Algunos clientes no permiten usar una ruta UNC (\\wsl.localhost\...) como directorio de trabajo. En ese caso, mantenga command como un ejecutable local de Windows y pase la ruta UNC sólo en args y PORTALV4_ROOT, o ejecute wsl.exe como wrapper.
