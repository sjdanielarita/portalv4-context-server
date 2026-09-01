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

El servidor expone 6 herramientas especializadas divididas por responsabilidades:

### 1. `get_module_structure` (Backend & Frontend)
**Propósito:** Garantizar el cumplimiento de la arquitectura modular desacoplada.
* **Qué hace:** Verifica si un módulo existe en la arquitectura clásica o en la nueva arquitectura `Modules`. Busca el nombre sin depender de mayúsculas/minúsculas y devuelve el nombre real del disco.
* **Payload exacto:** `{ "moduleName": "WebCoosajo" }`
* **Salida:** Destinos que incluyen ruta nativa absoluta, ruta portable con `/`, tipo y existencia actual.

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
* **Qué hace:** Lee las rutas registradas en memoria en Laravel y exporta una colección en formato **Postman Collection v2.1.0**.
* **Payload exacto:** `{ "prefix": "api/" }` *(Nota: `prefix` es opcional).*

### 5. `generate_tests` (Solo Backend)
**Propósito:** Proteger la base de datos de desarrollo frente a ejecuciones de tests destructivos.
* **Qué hace:** Genera la plantilla base PHP para pruebas automatizadas garantizando la importación y uso estricto del trait `DatabaseTransactions` (prohibiendo `RefreshDatabase`).
* **Payload exacto:** `{ "test_name": "BeneficioControllerTest", "type": "Feature", "module_name": "WebCoosajo" }` *(Nota: `module_name` es opcional).*

### 6. `review_quality_and_git` (Backend & Frontend)
**Propósito:** Estandarizar el control de versiones.
* **Qué hace:** Audita expresiones regulares para verificar que la rama inicie con los prefijos correctos (`feature/`, `bugfix/`, etc.) y que el mensaje cumpla con *Conventional Commits*.
* **Payload exacto:** `{ "branch_name": "feature/nueva-pantalla", "commit_message": "feat: agregar nueva pantalla" }`

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
