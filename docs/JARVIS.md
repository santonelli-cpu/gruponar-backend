# Reporte para Jarvis (portal → Google Drive)

Jarvis, el asistente de Stefano, necesita ver todas las operaciones del portal
para su agente de KYC/AML y para el briefing diario. En lugar de abrir el
portal con una sesión (dura 8 horas y pide 2FA), el portal **publica él solo**
una foto de solo lectura en el Google Drive que ya está conectado
(Equipo → Integraciones).

## Qué publica

**Una vez por semana** por defecto, en la carpeta
**"Jarvis (portal)"** de la raíz del Drive conectado:

- `portal-snapshot.json`: para que Jarvis lo lea por máquina.
- `portal-snapshot.md`: el mismo contenido en texto corrido.

Por cada operación no borrada: inmueble, tipo, estado, fechas (inicio, fin de
due diligence, cierre), escrow, estado del contrato, agentes y abogados, cada
parte (lado, tipo, estructura, socios, usuarios con su correo), documentos
con su estado y revisión, documentos pendientes, KYC por parte (formato,
estado, firma, cuántos campos están llenos y la fecha de vencimiento de la
identificación), tareas abiertas y los últimos 10 movimientos.

## Qué NO publica (a propósito)

- Las respuestas de los formularios KYC: ni números de identificación, ni
  CURP/RFC, ni cuentas, ni domicilios.
- Ligas a archivos (`file_url`, `generated_file_url`), sobres de DocuSign,
  contraseñas, secretos de 2FA ni teléfonos.
- Operaciones en la papelera.

La prueba `test/jarvisSnapshot.test.js` lo verifica: si algún dato sensible
se cuela al reporte, falla.

## Una sola vía

Jarvis solo lee el archivo en Drive. No hay endpoint para que escriba en el
portal ni llave nueva que guardar.

## Endpoints (solo admin)

- `GET /api/admin/jarvis/status`: si está activo, si Drive está conectado,
  última publicación y último error.
- `GET /api/admin/jarvis/preview`: el JSON exacto que se publica.
- `POST /api/admin/jarvis/publish`: publica ya, sin esperar a que toque.

## Frecuencia

`JARVIS_SNAPSHOT_EVERY_HOURS` en Render: `168` (por defecto, semanal) o `24`
(diario). El servidor revisa cada hora si ya pasó el intervalo desde la última
publicación buena, así que un reinicio no la duplica. Para una foto al momento,
`POST /api/admin/jarvis/publish`.

## Apagarlo

`JARVIS_SNAPSHOT_DISABLED=1` en las variables de entorno de Render. Si Drive
no está conectado, se salta solo y el portal funciona igual.
