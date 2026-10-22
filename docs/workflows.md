# CVG Studio CLI / CVG Studio View: núcleo de workflows

El subpath opcional `@cvg/workspace-protocol/workflows` y el ejecutable
`cvg-studio-cli` comparten la lógica que consume CVG Studio View. `cvg-workflow`
se conserva como alias compatible. El entrypoint del protocolo
sigue siendo neutral; las dependencias de Azure/Claude están en este módulo
optativo. Node 20 o superior. No necesita el servidor web.

## Uso local

Compilar el paquete con `npm run build`. Desde el checkout, ejecutar
`node dist/workflows/cli.js --help`; al instalar el paquete queda disponible el
binario `cvg-studio-cli`. No se instala ninguna skill global automáticamente.

`CVG_WORKFLOWS_ROOT` o `CASES_DIR` debe apuntar explícitamente al mismo directorio
de workspaces que Studio. Configurar `AZURE_DEVOPS_ORG` (nombre, no URL), un
`AZURE_DEVOPS_PROJECT` y `AZURE_DEVOPS_PAT`, o `AZURE_DEVOPS_AUTH_MODE=azure_cli`.
No guardar credenciales en los artefactos. Son las mismas credenciales existentes,
no una nueva configuración de permisos de Azure.

Comandos disponibles:

- `settings get`, `settings set task 2 <revision-esperada>`.
- `snapshot refresh CVG-001 123`, `snapshot history CVG-001 123`.
- `snapshot diff CVG-001 123 1 2`, `snapshot baseline CVG-001 123 2 1`.
- `pr list active`, `pr list all 50`, `pr prepare <url>`, `pr review <url>`, `pr history`.
- `sprint plan <tasks.json> 2`: planificación local, no importación ni ejecución.
- `sprint iterations <equipo>`, `sprint import <equipo> <iteration-id> <email-o-id>`.
- `sprint list`, `sprint history <sprint-local-id>`.

## Importación y planificación de sprints

En View, abrir **Sprints**, elegir proyecto, equipo, sprint e identidad exacta.
El mismo flujo está en CLI. Se leen todos los work items de la iteración por
lotes de hasta 200 y se captura el ámbito completo como evidencia; solo los
asignados al email/ID indicado reciben un workspace de tarea. No se filtra por
nombre visible. Cambios de responsable o iteración durante la captura abortan
esa importación y quedan reintentables.

Los workspaces tienen IDs estables por origen y tarea, no por sprint. No se
reinician las versiones ni se borran workspaces por un cambio de membresía.
Cada importación completa crea un historial inmutable de miembros, orden y
preferencias usadas. Un intento parcial conserva lo capturado y el registro de
avance; repetirlo retoma por identidades estables. No hay reanudación automática
en segundo plano aún. Un fallo no publica una importación incompleta como completa.

Las dependencias Azure explícitas proponen grupos y señalan referencias externas,
ciclos y dependientes bloqueados. No infieren que una tarea externa esté terminada.
El plan no inicia agentes ni verifica aún conflictos de puertos/repos/ambientes;
el scheduler debe añadir esas comprobaciones antes de ejecutar. El ciclo legacy
del caso sigue separado de la planificación: no se han migrado sus transiciones.

## Persistencia

Cada origen se identifica por proveedor, organización, proyecto e ID. Sus
versiones se guardan bajo `<workspace>/source-versions/<hash>/v00000001.json`.
La huella incluye el contenido completo capturado; orden de claves JSON no crea
cambios. Un refresco sin cambios solo registra una comprobación. Una reversión
a un contenido anterior sí crea otra versión respecto de la última captura.

`baseline.json` señala la versión en uso; actualizar no la mueve. Las lecturas
incompletas o concurrentes no pisan versiones anteriores. Los archivos legacy son
proyecciones de compatibilidad, no el historial canónico. Una copia legacy puede
estar resumida: se etiqueta como importada. La captura Azure conserva descripción
completa, campos nativos, criterios, relaciones y comentarios paginados. Adjuntos
y enlaces se conservan como referencias, no se descargan sus bytes.

`_workflows/settings.json` usa revisión esperada para evitar actualizaciones
perdidas. `_workflows/reviews/` conserva evidencia e informes por ejecución.
La inmutabilidad es lógica y verificable por hash, no un dispositivo WORM:
un usuario con acceso al disco puede alterar archivos, y las lecturas lo detectan.

## Revisión de PR

Solo Azure en esta entrega. Listado por proyecto, 50 por página, sin filtro
implícito de autor. El detalle se fija a una iteración, commits fuente/destino y
base común. Se leen contenidos antes/después mediante APIs GET; nunca checkout,
instalación de dependencias ni ejecución del repositorio.

Límites: 200 archivos, 60 KB por archivo, 300 KB de texto total y 8 MB por
respuesta HTTP. Binarios, archivos ilegibles y límites aparecen como omisiones.
El contexto puede no cubrir dependencias externas al diff. El runner inicial usa
Claude nativo (`CLAUDE_BIN`, `.exe` en Windows), con `--safe-mode`, sin tools,
skills ni MCP. Se envía el texto al proveedor de ese CLI. Otro runtime puede
implementar `TextReviewer` sin cambiar el almacenamiento.

La revisión no aprueba ni publica el PR. Después del análisis se compara el SHA;
si cambia, el resultado queda desactualizado. Al reabrir, Studio vuelve a comprobar
la vigencia; si falla la consulta, no asegura que esté vigente. No se ejecutan
tests como parte de este análisis. La revisión HTTP aún no es un job recuperable;
el informe se persiste cuando termina y una caída intermedia requiere reintentar.

## Límites deliberados

Todavía no hay worktrees, scheduler de ejecución durable,
botón Crear PR operativo ni ejecutor visual/API supervisado. Los contratos y
`testEligibility` ayudan a planificar; NO constituyen un sandbox ni modifican los
runners legacy. Revalidar manualmente análisis previos al cambiar baseline.
Migrar el ciclo completo `caso.json` al protocolo sigue pendiente.

Studio usa una dependencia local `file:../../cvg-workspace-protocol` para este
checkout. Para distribuirlo fuera del árbol, compilar y empaquetar el protocolo
con `npm pack` e instalar el tarball en la extensión; no transportar un symlink
roto. La preparación del instalador/VSIX con ese paquete queda pendiente.

## Verificación

`npm test` verifica también las invariantes de workflows. Los tests usan carpetas
temporales, Azure simulado y un revisor determinista; no publican PRs, no consultan
cuentas reales ni consumen una llamada al modelo. La aceptación con credenciales
y un PR real es una comprobación separada, todavía necesaria.

Validación de la entrega del 9/9/2026: 27 tests del núcleo y 1 test de aceptación
HTTP aprobados; 8 skills y 6 esquemas con 62 fixtures semánticos validados por los
verificadores del paquete. El validador Python auxiliar de skills no pudo correr
por ausencia de PyYAML; no se instaló una dependencia global para suplirlo.
TypeScript del protocolo/servidor/View y build Vite aprobados (aviso de tamaño de
chunks, sin error). Recorridos comprobados en navegador con datos sintéticos:
listar/seleccionar/revisar PR, abrir informe, importar sprint, abrir su workspace,
consultar versiones y refrescar sin crear un duplicado. No se probó aún una llamada
real del revisor a Claude ni el acceso real a Azure.
