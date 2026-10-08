import { photoRefError } from '@jellyfish/shared';

export interface PhotoEdit {
  /** Lo escrito, sin espacios en los extremos. */
  clean: string;
  photoChanged: boolean;
  illustrativeChanged: boolean;
  /** Hay algo que guardar. */
  changed: boolean;
  /** Bloquea guardar: solo se valida lo que la persona escribió de nuevo. */
  error: string | null;
  /** La foto guardada de antes no es válida y no se tocó: se avisa, pero no impide guardar lo demás. */
  legacyWarning: string | null;
  /** Cuerpo del PATCH: solo los campos que cambiaron. */
  body: { photo?: string; photoIllustrative?: boolean };
}

/**
 * Edición de la foto de un artículo. Una foto heredada que ya no pasa la validación (por ejemplo
 * "fotos/pechuga.jpg") no puede impedir guardar solo el cambio de "Imagen ilustrativa".
 */
export function checkPhotoEdit(
  saved: { photo: string; photoIllustrative: boolean },
  text: string,
  illustrative: boolean,
): PhotoEdit {
  const clean = text.trim();
  const photoChanged = clean !== saved.photo.trim();
  const illustrativeChanged = illustrative !== saved.photoIllustrative;
  const problem = photoRefError(clean);
  return {
    clean,
    photoChanged,
    illustrativeChanged,
    changed: photoChanged || illustrativeChanged,
    error: photoChanged ? problem : null,
    legacyWarning: !photoChanged ? problem : null,
    body: {
      ...(photoChanged ? { photo: clean } : {}),
      ...(illustrativeChanged ? { photoIllustrative: illustrative } : {}),
    },
  };
}
