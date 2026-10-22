# Integración portal → HubSpot

Sincronización de **una sola vía**: el portal manda sus operaciones a HubSpot.
HubSpot nunca escribe en el portal. El portal sigue siendo la fuente de verdad
de cada cierre; HubSpot es el CRM (contactos, empresas, pipeline, campañas).

## Qué se manda

| Portal | HubSpot |
|---|---|
| Operación (`deals`) | Deal en el pipeline **GrupoNAR** (`46373633`), llave `portal_deal_id` |
| `property` | `dealname` |
| `closing_date` | `closedate` (mediodía en Bahía de Banderas, UTC-6) |
| `price + furniture_price` (si la moneda es USD) | `precio_de_la_compraventa` |
| `development` | `municipio` (solo los que tienen municipio claro) |
| `status = completed` | etapa **Signed Deed**, salvo que el deal ya esté en Signed Deed o Deed Ready for Pick Up |
| Partes con cuenta y correo | Contactos (`cliente_vendedor` / `cliente_comprador`) |
| Agentes / abogados externos ligados | Contactos (`agente_inmobiliario` / `abogado_externo`) |
| Escrow (TLA / Armour) y agencia del agente | Asociación con la empresa **si ya existe** en HubSpot |

Al crear un deal: etapa **Purchase Agreement Signed** (o Signed Deed si ya está
completada), `tipo_de_servicio = coordinacion_de_cierre` y, si existe
`HUBSPOT_OWNER_ID`, ese propietario.

## Qué NO hace (a propósito)

- No pisa lo capturado en HubSpot: en contactos solo llena campos vacíos;
  `consentimiento_comercial = sin_registrar` solo se pone al **crear** el contacto.
- No cambia la etapa de un deal activo que ya existe (eso se mueve en HubSpot).
- No crea empresas, no borra nada. Mandar una operación a la papelera o borrarla
  en el portal no la borra en HubSpot.
- No manda personal interno (`@gruponar.com`, admin, abogado interno) ni partes
  sin correo.
- Ignora operaciones cuyo nombre empieza con "test" o "prueba".

## Cuándo se sincroniza

- Automático: después de cada escritura exitosa en `/api/deals` sobre la
  operación, sus partes o sus agentes (`POST /`, `PATCH /:id`, `DELETE /:id`,
  `/:id/parties…`, `/:id/agents…`, `/:id/restore`). Se encola y se procesa en
  segundo plano (`setImmediate`): la respuesta al usuario no espera a HubSpot.
- Manual (solo admin): `POST /api/admin/hubspot/sync` manda todas las
  operaciones no borradas. `GET /api/admin/hubspot/status` muestra si hay token,
  la cola y los últimos 20 resultados (`hubspot_sync_log`).

Si `HUBSPOT_TOKEN` está vacío, todo esto queda apagado y el portal funciona igual.

## Configuración

1. Crear la credencial en HubSpot (ver `HUBSPOT-SETUP-STEFANO.md` en la entrega):
   **Service key** (Development → Keys → Service keys) o, mientras HubSpot lo
   permita, una private app heredada. Ambas se usan como `Authorization: Bearer`.
2. Scopes mínimos:
   - `crm.objects.deals.read`, `crm.objects.deals.write`
   - `crm.objects.contacts.read`, `crm.objects.contacts.write`
   - `crm.objects.companies.read`, `crm.objects.companies.write`
   - `crm.schemas.deals.write` (solo para el script de setup; se puede quitar después)
3. En Render → servicio → Environment: `HUBSPOT_TOKEN=<la credencial>`.
   Opcional: `HUBSPOT_OWNER_ID`. **Nunca** en el repo (es público), ni en `.env.example`.
4. Una vez: `node scripts/hubspot-setup.js` (en la Shell de Render) — crea la
   propiedad única de deals `portal_deal_id` y revisa pipeline/propiedades.
   `--check` solo revisa.
5. Admin → `POST /api/admin/hubspot/sync` para el primer envío completo.

Variables opcionales para un pipeline distinto: `HUBSPOT_PIPELINE_ID`,
`HUBSPOT_STAGE_NEW`, `HUBSPOT_STAGE_SIGNED`.

## Errores

Cada operación tiene su última corrida en `hubspot_sync_log`
(`ok` / `error` / `skipped` + detalle). Los 429 se reintentan respetando
`Retry-After`; los demás errores se registran y se reintentan en la siguiente
escritura o en el sync manual. El token nunca se escribe en logs.
