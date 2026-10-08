/**
 * Se importa PRIMERO en el punto de entrada del navegador (browser.ts).
 *
 * El alojamiento donde se publica la vista previa no permite `eval` ni `new Function` (política de
 * seguridad). zod intenta compilar sus validadores con `new Function` en cuanto se construye un esquema
 * y, si no puede, solo cae a su modo normal; pero ese intento queda anotado como violación de la política.
 * Con `jitless` no lo intenta. Tiene que ejecutarse ANTES de que se construya cualquier esquema, por eso
 * vive en su propio módulo y no dentro de `boot()`.
 */
import { config } from 'zod';

config({ jitless: true });
