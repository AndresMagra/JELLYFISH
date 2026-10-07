# Catálogo JELLYFISH

Fuente de verdad del catálogo inicial. **Todo es reemplazable**: cuando tengas tu inventario y precios reales, sube tu propio CSV con el mismo formato y los datos sembrados se sustituyen.

## Archivos

| Archivo             | Para qué sirve                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `categories.json`   | Categorías y subcategorías (slugs usados por el CSV)                                      |
| `products.seed.csv` | 112 artículos vendibles (98 productos) de carnes, aves, pescados, mariscos y combos de RD |
| `template.csv`      | Plantilla con 3 filas de ejemplo para tu inventario                                       |

## Cómo se debe leer el precio

Cada fila trae `precio_fuente`:

| Valor      | Significado                                                                                                                                                                                                                   | ¿Se puede publicar?      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `ancla`    | Precio visto para un supermercado dominicano en 2026 (13 filas). **Aún no verificado en la tienda**: viene de resúmenes de un buscador, porque los sitios de los supermercados estaban bloqueados en la sesión de desarrollo. | Sí, tras confirmar ITBIS |
| `estimado` | Calculado por comparación con los precios ancla (99 filas). **No es un precio de mercado.**                                                                                                                                   | **No** hasta confirmarlo |
| `usuario`  | Confirmado por el dueño del negocio                                                                                                                                                                                           | Sí, tras confirmar ITBIS |

Un artículo solo es **publicable** si: está activo, su precio no es `estimado` y su ITBIS fue confirmado (columna `itbis`: `0`, `18` o `exento`/`gravado`). Con la semilla actual, **ningún artículo es publicable** — es intencional.

Precios ancla usados (RD$/lb): pechuga deshuesada 174.95 · filete pechuga importada congelada 135 · filete pechuga Cibao congelada 185 · res para guisar 295 · molida 90/10 229 · molida 96/4 299.95 · camarón precocido 26/30 349.95 · precocido 51/60 289.95 · crudo 16/20 879.95 · langostino precocido 449.95 · langostino crudo 429.95 · filete de dorado 869.95 · filete de salmón 949.95.

Nota: "Filete Dorada" figura así en la fuente. Puede ser dorado (mahi-mahi) o dorada (besugo); verificar el producto real.

## Columnas del CSV

| Columna                       | Obligatoria | Detalle                                                                          |
| ----------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `sku`                         | sí          | Único por fila                                                                   |
| `grupo`                       | no          | Agrupa variantes (calibres, marcas) en una ficha. Si falta, se deriva del nombre |
| `nombre`                      | sí          | Nombre del producto                                                              |
| `variante`                    | no          | Etiqueta de la variante (`16/20`, `Cibao congelada`)                             |
| `categoria`                   | sí          | Slug de `categories.json`                                                        |
| `subcategoria`                | no          | Texto libre                                                                      |
| `unidad`                      | sí          | `lb` (por libra) o `unit` (por unidad/combo)                                     |
| `paso_lb` / `minimo_lb`       | no          | Incremento y mínimo al pedir por libra (por defecto 0.5 y 1)                     |
| `peso_pieza_lb`               | no          | Peso aproximado de una pieza o combo                                             |
| `precio`                      | sí          | RD$ por libra o por unidad, **con ITBIS incluido**, máximo 2 decimales           |
| `precio_fuente`               | no          | `ancla`, `estimado` o `usuario` (por defecto `usuario`)                          |
| `notas_precio`                | no          | De dónde salió el precio                                                         |
| `costo`                       | no          | Para calcular margen                                                             |
| `stock`                       | no          | Libras (si `lb`) o unidades (si `unit`)                                          |
| `itbis`                       | no          | `0`, `18`, `exento`, `gravado`. Vacío = por confirmar                            |
| `variable`                    | no          | `si` si el peso final puede variar (por defecto `si` en `lb`)                    |
| `congelado`                   | no          | Por defecto `si`                                                                 |
| `sinonimos`                   | no          | Separados por `;` — alimentan la búsqueda                                        |
| `descripcion`, `como_cocinar` | no          | Texto para la ficha                                                              |
| `foto`                        | no          | Ruta o nombre de archivo de la foto                                              |
| `activo`                      | no          | Por defecto `si`                                                                 |

El importador acepta cabeceras con o sin acentos, y archivos de Excel en español (separador `;` y coma decimal).

## Validar sin tocar nada

```bash
npm run catalog:check                       # revisa la semilla
npm run catalog:check -- ruta/mi-inventario.csv
```

Muestra errores por fila (con SKU y campo), avisos (costo > precio, precios sospechosos) y cuántos artículos siguen bloqueados para publicar y por qué.
