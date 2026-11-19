# CivitView

Cliente web no oficial, pensado para el móvil, para ojear Civitai (imágenes y modelos). Solo lectura: usa la API pública de Civitai y no necesita cuenta.

- Feed de imágenes con scroll infinito, visor a pantalla completa con gestos (deslizar para cambiar, hacia abajo para cerrar, hacia arriba para ver la info).
- Prompt, parámetros y modelos usados en cada imagen.
- Modelos: búsqueda, filtros, ficha con versiones, palabras clave, galería y descargas.
- Filtros extra: modelo base, orientación, mínimo de reacciones, texto en el prompt, usuarios ocultos, mínimo de descargas, sin pago, uso comercial.
- Instalable como app (PWA).

Para probar en local: `python -m http.server 8787` y abrir http://localhost:8787
