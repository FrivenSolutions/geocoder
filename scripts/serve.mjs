// Static server for dist/, used only to exercise the app in a browser during development.
// The shipped tool needs no server at all - see build-app.mjs.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".txt": "text/plain", ".csv": "text/csv" };
createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split("?")[0]);
    const file = join(dist, path === "/" ? "geocoder.html" : path);
    try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
        res.end(body);
    } catch {
        res.writeHead(404).end("not found");
    }
}).listen(8231, () => console.log("http://localhost:8231"));
