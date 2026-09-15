/**
 * Extracción de datos de respuestas SOAP por expresiones regulares.
 *
 * Es deliberado que no haya un parser XML: las respuestas de ARCA son planas y
 * predecibles, y sumar una dependencia de parseo para leer diez tags obligaría
 * a auditarla — este paquete maneja un certificado fiscal y su valor es tener
 * cero dependencias. Las regex toleran cualquier prefijo de namespace porque
 * ARCA no es consistente entre servicios (`<ns2:estado>` y `<estado>` conviven).
 */

/**
 * Devuelve el contenido del tag con las entidades XML ya resueltas.
 *
 * El desescapado importa: una razón social como `LOPEZ &amp; CIA S.A.` se
 * devolvería literal, con el `&amp;` adentro, y eso viaja tal cual a una
 * planilla o a un correo.
 */
function desescapar(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    // El & va último: si no, se re-expanden las entidades recién resueltas.
    .replace(/&amp;/g, '&');
}

function expresion(nombre, global = false) {
  return new RegExp(
    `<(?:[^:>\\s]+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[^:>\\s]+:)?${nombre}>`,
    global ? 'g' : '',
  );
}

/** Primer valor del tag, o null. */
export function tag(xml, nombre) {
  if (!xml) return null;
  const m = xml.match(expresion(nombre));
  return m ? desescapar(m[1].trim()) : null;
}

/**
 * Último valor del tag, o null.
 *
 * Existe por los servicios .NET: en WSFE el `PtoVta` propio del comprobante se
 * serializa DESPUÉS del de los comprobantes asociados, así que el primer match
 * de una nota de crédito devuelve el punto de venta de la factura asociada.
 */
export function ultimoTag(xml, nombre) {
  const todos = tags(xml, nombre);
  return todos.length > 0 ? todos[todos.length - 1] : null;
}

/**
 * Todos los valores del tag, en orden de aparición.
 *
 * Ojo: no soporta tags del mismo nombre anidados uno dentro de otro — la regex
 * corta en el primer cierre. Ninguna respuesta de ARCA lo hace hoy, pero si se
 * agrega una operación de listado que anide (`getPersonaList` devuelve
 * `persona` dentro de `personaListReturn`), hay que revisarlo.
 */
export function tags(xml, nombre) {
  if (!xml) return [];
  const re = expresion(nombre, true);
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(desescapar(m[1].trim()));
  return out;
}

/** El tag como número, o null si no está o no es numérico. */
export function numero(xml, nombre) {
  const v = tag(xml, nombre);
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Lista de { codigo, descripcion } a partir de los <error> de la respuesta. */
export function errores(xml) {
  return tags(xml, 'error').map((e) => ({
    codigo: tag(e, 'codigo'),
    descripcion: tag(e, 'descripcion') || e,
  }));
}

/** Mensaje de error legible de una respuesta fallida de ARCA. */
export function mensajeDeError(xml, porDefecto) {
  return (
    tag(xml, 'descripcion') ||
    tag(xml, 'faultstring') ||
    tag(xml, 'errorMsg') ||
    porDefecto
  );
}
