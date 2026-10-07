/**
 * Errores de dominio con código estable y mensaje en español: los mismos códigos, estados HTTP y
 * textos que `apps/api/src/errors.ts` (la prueba de contrato lo comprueba contra el API real).
 */
export class DemoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DemoError';
  }
}

export const notFound = (what: string) => new DemoError('not_found', `${what} no encontrado`, 404);
export const forbidden = (message = 'No tienes permiso para esta acción') =>
  new DemoError('forbidden', message, 403);
export const unauthorized = (message = 'Inicia sesión para continuar') =>
  new DemoError('unauthorized', message, 401);
export const conflict = (code: string, message: string, details?: unknown) =>
  new DemoError(code, message, 409, details);
export const invalid = (message: string, details?: unknown) =>
  new DemoError('validation', message, 400, details);
export const tooMany = (message = 'Demasiados intentos. Espera un momento.') =>
  new DemoError('rate_limited', message, 429);
