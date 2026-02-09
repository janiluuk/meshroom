import { buildServer } from "./server";
import { loadConfig } from "./config";

const config = loadConfig();
const server = buildServer(config);

const start = async () => {
  try {
    await server.listen({
      port: config.server.port,
      host: config.server.host
    });
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
};

start();
