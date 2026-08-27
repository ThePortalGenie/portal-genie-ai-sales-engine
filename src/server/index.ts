import { createServer } from "node:http";
import { loadEnvFile } from "../config/load-env.js";
import { handleRequest } from "./app.js";

loadEnvFile();

const host = process.env.APP_HOST ?? "127.0.0.1";
const port = Number(process.env.APP_PORT ?? 8787);

const server = createServer((req, res) => {
  void handleRequest(req, res);
});

server.listen(port, host, () => {
  process.stdout.write(`Sales Engine UI: http://${host}:${port}/\n`);
  process.stdout.write("Zoho credentials stay on the server. Bind is localhost by default.\n");
});
