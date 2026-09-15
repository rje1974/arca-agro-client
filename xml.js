/**
 * Extracción de datos de respuestas SOAP por expresiones regulares.
 *
 * Es deliberado que no haya un parser XML: las respuestas de ARCA son planas y
 * predecibles, y sumar una dependencia de parseo para leer diez tags obligaría
 * a auditarla — este paquete maneja un certificado fiscal y su valor es tener
 * cero dependencias. Las regex toleran cualquier prefijo de namespace porque
 * ARCA no es consistente entre servicios (`<ns2:estado>` y `<estado>` conviven).
 */

/** Primer valor del tag, o null. */
export function tag(xml, nombre) {
  if (!xml) return null;
  const m = xml.match(
    new RegExp(`<(?:[^:>\\s]+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[^:>\\s]+:)?${nombre}>`),
  );
  return m ? m[1].trim() : null;
}

/** Todos los valores del tag, en orden de aparición. */
export function tags(xml, nombre) {
  if (!xml) return [];
  const re = new RegExp(
    `<(?:[^:>\\s]+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[^:>\\s]+:)?${nombre}>`,
    'g',
  );
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
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
