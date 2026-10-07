import { BUSINESS, type BusinessData } from '../business';

/**
 * Textos legales de JELLYFISH (español dominicano, tuteo).
 *
 * ESTADO: BORRADOR. Mientras `LEGAL_DRAFT` sea `true` la app muestra la franja
 * "Borrador pendiente de revisión legal" en cada documento. El dueño la apaga poniéndolo en
 * `false` DESPUÉS de que un abogado revise estos textos y de completar los datos de
 * `business.ts` (razón social, RNC, dirección, teléfono y correo de soporte).
 *
 * Los textos son plantillas: `{negocio}`, `{razonSocial}`, `{rnc}`, `{direccion}`, `{telefono}` y
 * `{correo}` se reemplazan con los datos de `BUSINESS` (ver `renderLegalDoc`). Los datos que aún no
 * existen salen como "[por definir]"; ningún otro marcador pendiente debe quedar en los textos
 * (hay una prueba que lo vigila).
 */
export const LEGAL_DRAFT = true;

/** Fecha (AAAA-MM-DD) de la última actualización de los textos. Súbela cuando cambies cualquiera. */
export const LEGAL_UPDATED_AT = '2026-10-07';

export type LegalDocId = 'terminos' | 'privacidad' | 'devoluciones' | 'cadena-de-frio';

/** Un bloque es un párrafo o una lista con viñetas. */
export type LegalBlock = string | { list: string[] };

export interface LegalSection {
  heading: string;
  blocks: LegalBlock[];
}

export interface LegalDoc {
  id: LegalDocId;
  title: string;
  /** Una línea para la lista de documentos. */
  summary: string;
  updatedAt: string;
  sections: LegalSection[];
}

/** Marcadores de plantilla permitidos y el dato del negocio que los reemplaza. */
export const LEGAL_TOKENS = {
  negocio: 'tradeName',
  razonSocial: 'legalName',
  rnc: 'taxId',
  direccion: 'address',
  telefono: 'phone',
  correo: 'supportEmail',
} as const satisfies Record<string, keyof BusinessData>;

const TERMINOS: LegalDoc = {
  id: 'terminos',
  title: 'Términos y condiciones',
  summary: 'Cómo funciona {negocio}: cuenta, precios, pagos, entrega y tus responsabilidades.',
  updatedAt: LEGAL_UPDATED_AT,
  sections: [
    {
      heading: '1. Quiénes somos',
      blocks: [
        '{negocio} es una tienda de comida congelada (carnes, aves, pescados y mariscos) con entrega a domicilio en República Dominicana. Estos términos explican cómo usar la app y cómo funciona una compra.',
        {
          list: [
            'Operado por: {razonSocial}',
            'RNC: {rnc}',
            'Dirección: {direccion}',
            'Teléfono: {telefono}',
            'Correo de soporte: {correo}',
          ],
        },
        'Al crear una cuenta o hacer un pedido aceptas estos términos y la Política de privacidad.',
      ],
    },
    {
      heading: '2. Tu cuenta',
      blocks: [
        'Puedes mirar el catálogo y llenar el carrito sin cuenta. Para pedir entras con tu número de celular dominicano y un código de 6 dígitos que te enviamos por mensaje.',
        {
          list: [
            'Debes ser mayor de edad para comprar.',
            'Tú respondes por lo que se haga con tu cuenta: no compartas tu código de acceso.',
            'Da datos verdaderos (nombre, dirección y referencia): de eso depende que el pedido llegue.',
            'Puedes borrar tu cuenta cuando quieras desde Perfil, en “Eliminar mi cuenta”.',
          ],
        },
      ],
    },
    {
      heading: '3. Productos y precios',
      blocks: [
        'Todos los precios están en pesos dominicanos (RD$) e incluyen el ITBIS, igual que en una góndola. El envío se muestra aparte, antes de que confirmes.',
        'El servidor de {negocio} calcula el total de tu pedido. El que ves en el carrito es una cotización; el que vale es el que aparece al confirmar. Si un precio o una existencia cambia mientras compras, la app te lo muestra antes de que pagues.',
        'Si un precio publicado tiene un error evidente, podemos cancelar el pedido afectado y devolverte lo que hayas pagado.',
        'Las fotos son de referencia. Las que dicen “Imagen ilustrativa” no son una foto del producto exacto que recibirás: el tamaño, la forma y el corte pueden variar un poco.',
      ],
    },
    {
      heading: '4. Productos de peso variable',
      blocks: [
        'Las carnes, pescados y mariscos se venden por libra y el peso exacto se conoce cuando empacamos. Por eso el total que ves antes es un estimado.',
        {
          list: [
            'Se cobra el peso real empacado.',
            'Si el peso real cuesta menos que el estimado, te devolvemos la diferencia.',
            'Nunca pagarás más del monto máximo que te mostramos al confirmar el pedido.',
          ],
        },
      ],
    },
    {
      heading: '5. Zonas, horarios y entrega',
      blocks: [
        'Entregamos solo en las zonas que cubrimos. Al poner tu dirección te decimos si llegamos, el pedido mínimo y el costo de envío de tu zona.',
        'Tú eliges una franja de entrega. Es una ventana de tiempo, no una hora exacta; hacemos lo posible por llegar dentro de ella.',
        'Alguien debe recibir el pedido en la dirección. Si no podemos entregarlo porque nadie recibe, la dirección no es correcta o no logramos contactarte, el pedido queda como “No pudimos entregar” y te escribimos para reprogramar. Como el producto es congelado y perecedero, si la cadena de frío ya no se puede garantizar, la decisión de reprogramar o reembolsar se toma caso por caso y te la explicamos.',
        'Cuando el pedido va en camino puedes ver en la app si tu repartidor está compartiendo su ubicación.',
      ],
    },
    {
      heading: '6. PIN de entrega',
      blocks: [
        'Cada pedido tiene un PIN de 4 dígitos que solo tú ves en el detalle del pedido. El repartidor lo necesita para cerrar la entrega.',
        {
          list: [
            'Díselo al repartidor solo cuando te llegue el pedido y lo tengas en la mano.',
            'No lo compartas por mensaje ni por llamada, ni con nadie que no sea quien te entrega.',
            'Con varios intentos equivocados el PIN se bloquea y nuestro equipo te ayuda a cerrar la entrega.',
          ],
        },
      ],
    },
    {
      heading: '7. Formas de pago',
      blocks: [
        {
          list: [
            'Tarjeta de crédito o débito: pagas en la página segura del procesador de pagos. {negocio} no recibe ni guarda el número de tu tarjeta.',
            'Efectivo contra entrega: pagas al repartidor el monto exacto al recibir. Ten el dinero listo.',
            'Transferencia bancaria: te damos los datos de la cuenta y tú nos mandas el número de referencia. El pedido se confirma cuando verificamos la transferencia.',
          ],
        },
        'Mientras un pedido espera el pago reservamos tus productos por un tiempo limitado. Si no se paga a tiempo, el pedido se cancela y los productos vuelven a estar disponibles.',
      ],
    },
    {
      heading: '8. Cancelaciones, devoluciones y reembolsos',
      blocks: [
        'Puedes cancelar desde la app mientras el pedido esté “Esperando pago” o “Pedido confirmado”. Las reglas completas, los plazos para reportar un problema y cómo devolvemos el dinero están en la política de Devoluciones y reembolsos.',
      ],
    },
    {
      heading: '9. Productos congelados: tu parte',
      blocks: [
        'Para que el producto llegue y se mantenga seguro, hace falta tu ayuda: revisa el pedido al recibirlo, guárdalo de inmediato en el congelador y no lo vuelvas a congelar si ya se descongeló. Los detalles están en Cadena de frío y recepción del pedido.',
      ],
    },
    {
      heading: '10. Cupones',
      blocks: [
        'Un cupón tiene sus propias condiciones (por ejemplo, vigencia, monto mínimo o número de usos). Si no se puede aplicar, la app te dice por qué. Un cupón no se cambia por dinero.',
      ],
    },
    {
      heading: '11. Uso adecuado',
      blocks: [
        'No uses la app para engañar, para pedir con datos falsos, para probar códigos o PIN de otras personas ni para dañar el servicio. Podemos suspender cuentas que lo hagan.',
      ],
    },
    {
      heading: '12. Responsabilidad',
      blocks: [
        'Hacemos lo posible para que todo funcione bien, pero no controlamos las fallas de internet, de tu operadora ni de los mensajes de texto. Nada de lo que dicen estos términos limita los derechos que las leyes de protección al consumidor de la República Dominicana te dan.',
      ],
    },
    {
      heading: '13. Cambios a estos términos',
      blocks: [
        'Podemos actualizar estos términos. La fecha de la última actualización aparece arriba. Si el cambio es importante te lo avisaremos en la app antes de que se aplique a tus próximos pedidos.',
      ],
    },
    {
      heading: '14. Ley aplicable y contacto',
      blocks: [
        'Estos términos se rigen por las leyes de la República Dominicana. Para cualquier duda o reclamo escríbenos a {correo} o llama al {telefono}.',
      ],
    },
  ],
};

const PRIVACIDAD: LegalDoc = {
  id: 'privacidad',
  title: 'Política de privacidad',
  summary: 'Qué datos guardamos, para qué, por cuánto tiempo y cómo ejercer tus derechos.',
  updatedAt: LEGAL_UPDATED_AT,
  sections: [
    {
      heading: '1. Quién es responsable de tus datos',
      blocks: [
        'El responsable del tratamiento de tus datos personales es {razonSocial} (nombre comercial {negocio}), RNC {rnc}, con dirección en {direccion}. Para cualquier consulta sobre tus datos escribe a {correo}.',
      ],
    },
    {
      heading: '2. Qué datos guardamos',
      blocks: [
        {
          list: [
            'Teléfono: para que puedas entrar con tu código y para contactarte por tu pedido.',
            'Nombre: para identificarte al entregar. Lo escribes tú.',
            'Direcciones: calle y número, sector, ciudad y referencia para el repartidor.',
            'Ubicación de una dirección (latitud y longitud): solo si tú tocas “Usar mi ubicación actual” al crear la dirección. Puedes quitarla antes de guardar.',
            'Pedidos: los productos, montos, horario elegido, método de pago, notas, estado y el PIN de entrega, junto con una copia de la dirección de ese pedido.',
            'Pagos: el estado y el monto de cada pago y, en transferencias, la referencia que escribes. No guardamos el número de tu tarjeta: lo recibe el procesador de pagos.',
            'Token de notificaciones: un identificador de tu teléfono que usamos solo para enviarte avisos de tus pedidos, si aceptas recibirlos.',
            'Registros técnicos del servidor (por ejemplo, fechas, errores y solicitudes) para mantener el servicio seguro y funcionando.',
          ],
        },
        'Lo que NO hacemos: no seguimos tu ubicación. Solo leemos tu posición una vez, cuando tú lo pides. Tu carrito y tus favoritos se guardan únicamente en tu teléfono y no se envían a nuestros servidores.',
      ],
    },
    {
      heading: '3. Para qué los usamos',
      blocks: [
        {
          list: [
            'Preparar, cobrar, entregar y dar seguimiento a tus pedidos.',
            'Contactarte sobre un pedido (llamada, mensaje o WhatsApp) y enviarte el código de acceso.',
            'Hacer reembolsos y atender reclamos.',
            'Avisarte en el teléfono cuando tu pedido cambia de estado, si activaste las notificaciones.',
            'Proteger el servicio: por ejemplo, limitar los intentos de código y de PIN para evitar fraudes.',
          ],
        },
        'No vendemos tus datos personales.',
      ],
    },
    {
      heading: '4. Con quién los compartimos',
      blocks: [
        {
          list: [
            'El repartidor que lleva tu pedido recibe tu nombre, teléfono y la dirección con su referencia (y las coordenadas, si las guardaste) solo para poder entregarlo. El repartidor no ve tu PIN: se lo dices tú en persona.',
            'El procesador de pagos recibe lo necesario para cobrar con tarjeta. Los datos de la tarjeta los escribes en su página, no en nuestra app.',
            'El proveedor de mensajes de texto o WhatsApp recibe tu número para enviarte el código de acceso.',
            'Los servicios de notificaciones del teléfono (Expo, Apple y Google) reciben tu token y el texto del aviso para entregártelo.',
            'Autoridades, cuando una ley o una orden válida lo exija.',
          ],
        },
      ],
    },
    {
      heading: '5. Cuánto tiempo los guardamos',
      blocks: [
        {
          list: [
            'Tu cuenta, tus direcciones y tu token de notificaciones: mientras tengas la cuenta. Si la eliminas, borramos tu nombre, tu correo (si lo habías dado), tus direcciones y tus tokens, y tu número deja de estar asociado a la cuenta.',
            'Pedidos y pagos: los conservamos, con la dirección de entrega que tenía cada pedido, por el tiempo que exijan las normas contables, fiscales y de protección al consumidor. No los usamos para otra cosa.',
            'Código de acceso: vence a los pocos minutos de enviarse.',
            'Ubicación del repartidor que ves en el seguimiento: se borra cuando termina la entrega.',
          ],
        },
      ],
    },
    {
      heading: '6. Tus derechos y cómo ejercerlos',
      blocks: [
        'Tienes derecho a saber qué datos tuyos tenemos, a corregirlos, a pedir que se eliminen y a oponerte a usos que no necesitas. Dentro de la app puedes:',
        {
          list: [
            'Acceso: ver tu nombre, teléfono, direcciones y pedidos en Perfil y en Pedidos.',
            'Rectificación: cambiar tu nombre en Perfil. Para corregir una dirección, elimínala y crea la correcta.',
            'Eliminación: borrar tu cuenta en Perfil, “Eliminar mi cuenta”.',
            'Ubicación: quitar la ubicación guardada al crear la dirección y retirar el permiso desde los ajustes del teléfono.',
            'Notificaciones: desactivarlas en los ajustes del teléfono.',
          ],
        },
        'Si algo de esto no lo puedes hacer desde la app, escríbenos a {correo} desde el número con el que compraste y te ayudamos.',
      ],
    },
    {
      heading: '7. Seguridad',
      blocks: [
        'Las comunicaciones entre la app y nuestro servidor van cifradas. Tu sesión se guarda en el almacenamiento seguro del teléfono, el PIN de entrega solo lo ve el dueño del pedido y limitamos los intentos de código. Aun así, ningún sistema es 100 % seguro: cuida tu teléfono y no compartas tus códigos.',
      ],
    },
    {
      heading: '8. Menores de edad',
      blocks: [
        'La app es para personas mayores de edad. No recopilamos datos de menores a propósito.',
      ],
    },
    {
      heading: '9. Marco legal y cambios',
      blocks: [
        'Esta política se basa en los principios de la Ley núm. 172-13 sobre Protección Integral de los Datos Personales de la República Dominicana: finalidad, consentimiento, calidad de los datos, seguridad, y derechos de acceso, rectificación y cancelación.',
        'Si la actualizamos, la fecha de arriba cambia y, si el cambio es importante, te avisaremos en la app.',
      ],
    },
  ],
};

const DEVOLUCIONES: LegalDoc = {
  id: 'devoluciones',
  title: 'Devoluciones y reembolsos',
  summary: 'Cuándo puedes cancelar, cómo reportar un problema y cómo te devolvemos el dinero.',
  updatedAt: LEGAL_UPDATED_AT,
  sections: [
    {
      heading: '1. Lo importante, en corto',
      blocks: [
        {
          list: [
            'Cancelas desde la app antes de que empecemos a preparar tu pedido.',
            'Pagas el peso real que empacamos; si pesa menos, te devolvemos la diferencia.',
            'Si algo llega mal, avísanos dentro de las 24 horas siguientes a la entrega y mándanos una foto.',
          ],
        },
      ],
    },
    {
      heading: '2. Cancelar un pedido',
      blocks: [
        'Puedes cancelar desde la app mientras tu pedido esté “Esperando pago” o “Pedido confirmado”. Si ya pagaste con tarjeta o transferencia, te devolvemos el dinero.',
        'Cuando el pedido pasa a “Preparando tu pedido” ya no se cancela desde la app, porque empezamos a seleccionar y pesar tus productos. Si todavía no lo hemos empacado, escríbenos o llámanos al {telefono} y vemos si podemos cancelarlo. Una vez empacado en frío o en camino, ya no es posible cancelarlo.',
        'Si pagas en efectivo y cancelas, no se cobra nada.',
      ],
    },
    {
      heading: '3. Productos de peso variable',
      blocks: [
        'Cobramos el peso real que empacamos. Si pesa menos que el estimado, la diferencia se te devuelve. Verás el total final en el detalle de tu pedido. Con tarjeta, la diferencia vuelve a la misma tarjeta; con efectivo, solo pagas el total final.',
      ],
    },
    {
      heading: '4. Si hay un problema con tu pedido',
      blocks: [
        'Por ser producto congelado y perecedero, necesitamos que nos avises pronto. Reporta el problema dentro de las 24 horas siguientes a la entrega, con foto del producto y de su empaque. Puedes hacerlo cuando falte algo, llegue algo que no pediste, o el producto llegue dañado, abierto o descongelado.',
        {
          list: [
            'Escríbenos a {correo} o llama al {telefono}.',
            'Dinos el código de tu pedido (por ejemplo, JF-000123) y qué pasó.',
            'Adjunta foto del producto y del empaque, donde se vea el problema.',
            'Mientras lo revisamos, no botes el producto. Si todavía está congelado, déjalo en el congelador.',
          ],
        },
      ],
    },
    {
      heading: '5. Qué hacemos cuando el reclamo procede',
      blocks: [
        'Según el caso, te reponemos el producto en una próxima entrega, o te reembolsamos el valor de lo afectado. Te explicamos la decisión por el mismo medio por el que nos escribiste.',
      ],
    },
    {
      heading: '6. Lo que no cubrimos',
      blocks: [
        {
          list: [
            'Cambios de opinión sobre producto congelado ya entregado en buen estado: por seguridad alimentaria no podemos volver a vender un producto perecedero que salió de nuestra cadena de frío.',
            'Producto que se descongeló o dañó después de recibirlo, por cómo se guardó.',
            'Reclamos que llegan después de las 24 horas o sin foto, salvo que no haya sido posible reportarlos antes y nos lo expliques.',
            'Entregas que no se pudieron completar porque nadie recibió el pedido o la dirección era incorrecta (mira Términos y condiciones, sección de entrega).',
          ],
        },
      ],
    },
    {
      heading: '7. Cómo te devolvemos el dinero',
      blocks: [
        {
          list: [
            'Tarjeta: al mismo medio de pago con el que pagaste.',
            'Transferencia: a la cuenta desde la que nos transferiste.',
            'Efectivo: por transferencia a la cuenta que nos indiques.',
          ],
        },
        'Te avisamos en la app cuando registramos el reembolso. El tiempo en que lo ves en tu cuenta o estado de tarjeta depende de tu banco. Si el pedido tenía un cupón, el reembolso es por lo que realmente pagaste.',
      ],
    },
  ],
};

const CADENA_DE_FRIO: LegalDoc = {
  id: 'cadena-de-frio',
  title: 'Cadena de frío y recepción del pedido',
  summary: 'Cómo cuidamos el frío hasta tu puerta y qué hacer cuando recibes tu pedido.',
  updatedAt: LEGAL_UPDATED_AT,
  sections: [
    {
      heading: '1. Nuestro compromiso',
      blocks: [
        'Empacamos tus productos congelados con hielo para que lleguen fríos y los llevamos a la franja de entrega que elegiste. Para que el frío no se rompa necesitamos que tú también cuides el último tramo.',
      ],
    },
    {
      heading: '2. Antes de que llegue',
      blocks: [
        {
          list: [
            'Elige una franja en la que haya alguien en casa para recibir.',
            'Deja espacio en el congelador.',
            'Ten a mano tu PIN de entrega (está en el detalle del pedido) y, si pagas en efectivo, el monto exacto.',
          ],
        },
      ],
    },
    {
      heading: '3. Cuando lo recibas, revísalo ahí mismo',
      blocks: [
        {
          list: [
            'El empaque está cerrado y sin roturas.',
            'El producto se siente firme y congelado, sin líquido suelto ni partes blandas.',
            'El olor es el normal del producto.',
            'Las cantidades y los productos son los que pediste.',
          ],
        },
        'Si algo no está bien, díselo al repartidor y reporta el problema dentro de las 24 horas, con foto, como explica la política de Devoluciones y reembolsos.',
      ],
    },
    {
      heading: '4. Guárdalo de inmediato',
      blocks: [
        'Pasa todo al congelador en cuanto lo recibas. Los alimentos congelados se conservan seguros a −18 °C o menos. Deja pasar lo menos posible entre la entrega y el congelador.',
      ],
    },
    {
      heading: '5. Descongelar con seguridad',
      blocks: [
        {
          list: [
            'Descongela en el refrigerador, no sobre el mesón a temperatura ambiente.',
            'Si tienes prisa, usa agua fría con el producto bien sellado en su funda, o el microondas si lo vas a cocinar enseguida.',
            'Cocina el producto completamente.',
            'No vuelvas a congelar un producto crudo que ya se descongeló.',
          ],
        },
      ],
    },
    {
      heading: '6. Si no puedes recibirlo',
      blocks: [
        'Avísanos cuanto antes al {telefono}. Si no se logra entregar, el pedido queda como “No pudimos entregar” y te contactamos, pero un producto congelado que estuvo fuera del frío puede no ser seguro: lo explicamos en Términos y condiciones, sección de entrega.',
      ],
    },
  ],
};

export const LEGAL_DOCS: Record<LegalDocId, LegalDoc> = {
  terminos: TERMINOS,
  privacidad: PRIVACIDAD,
  devoluciones: DEVOLUCIONES,
  'cadena-de-frio': CADENA_DE_FRIO,
};

/** Orden en que se muestran en listas y menús. */
export const LEGAL_DOC_IDS: readonly LegalDocId[] = [
  'terminos',
  'privacidad',
  'devoluciones',
  'cadena-de-frio',
];

export function isLegalDocId(value: unknown): value is LegalDocId {
  return typeof value === 'string' && (LEGAL_DOC_IDS as readonly string[]).includes(value);
}

/** Reemplaza `{negocio}`, `{rnc}`… por los datos del negocio. Un marcador desconocido queda igual. */
export function fillLegalTokens(text: string, business: BusinessData = BUSINESS): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const field = (LEGAL_TOKENS as Record<string, keyof BusinessData>)[key];
    return field ? business[field] : whole;
  });
}

/** El documento listo para mostrar: con los datos del negocio ya puestos. */
export function renderLegalDoc(id: LegalDocId, business: BusinessData = BUSINESS): LegalDoc {
  const doc = LEGAL_DOCS[id];
  const fill = (t: string) => fillLegalTokens(t, business);
  return {
    ...doc,
    summary: fill(doc.summary),
    sections: doc.sections.map((s) => ({
      heading: fill(s.heading),
      blocks: s.blocks.map((b) => (typeof b === 'string' ? fill(b) : { list: b.list.map(fill) })),
    })),
  };
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** "2026-10-07" → "7 de octubre de 2026". */
export function formatLegalDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} de ${month} de ${m[1]}` : iso;
}

/** Texto plano de todo el documento (para pruebas y para compartir). */
export function legalDocText(doc: LegalDoc): string {
  return [
    doc.title,
    ...doc.sections.flatMap((s) => [
      s.heading,
      ...s.blocks.flatMap((b) => (typeof b === 'string' ? [b] : b.list)),
    ]),
  ].join('\n');
}
