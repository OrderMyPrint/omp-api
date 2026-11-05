import type { INestApplication } from "@nestjs/common";
import type { Request, Response } from "express";

/**
 * Interactive API docs (Swagger UI) served from a pinned CDN copy with
 * Subresource Integrity, so nothing depends on static files being bundled into
 * the Vercel Function. The hashes match the npm package swagger-ui-dist@5.34.1.
 */
const VERSION = "5.34.1";
const CDN = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${VERSION}`;
const SRI = {
  css: "sha384-4c3vsE5f+trhFyHrFrLM1fFGUn531NIaC7dcqEWIJdoRQJ5CkJbSuSCwXLpaS1KF",
  bundle: "sha384-XFYN47VzPiDY6qPtxYKg0nqUeW/upo20xf1j2SUE7gT/i35FJB4cuS/71Iegzk8Z",
  preset: "sha384-My2aDM4r2Mbm3ybHcubKm9O9U8FEjvF/O5nGvE9YK5dzqOTbWEKa79RPJ1krdMaF",
};
export const DOCS_CDN_ORIGIN = "https://cdn.jsdelivr.net";

export function mountDocs(app: INestApplication, prefix: string) {
  const express = app.getHttpAdapter().getInstance();
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Order My Print API</title>
<link rel="stylesheet" href="${CDN}/swagger-ui.css" integrity="${SRI.css}" crossorigin="anonymous" />
</head>
<body>
<div id="swagger-ui"></div>
<script src="${CDN}/swagger-ui-bundle.js" integrity="${SRI.bundle}" crossorigin="anonymous"></script>
<script src="${CDN}/swagger-ui-standalone-preset.js" integrity="${SRI.preset}" crossorigin="anonymous"></script>
<script src="/${prefix}/docs/init.js"></script>
</body>
</html>`;
  const init = `window.ui = SwaggerUIBundle({ url: "/${prefix}/openapi.json", dom_id: "#swagger-ui", deepLinking: true, presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset], layout: "StandaloneLayout" });`;

  express.get(`/${prefix}/docs`, (_req: Request, res: Response) => {
    res.type("html").set("Cache-Control", "public, max-age=300").send(html);
  });
  express.get(`/${prefix}/docs/init.js`, (_req: Request, res: Response) => {
    res.type("application/javascript").set("Cache-Control", "public, max-age=300").send(init);
  });
}
