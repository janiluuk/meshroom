import { buildServer } from "./server";
import { loadConfig } from "./config";

const config = loadConfig();

const start = async () => {
  const server = await buildServer(config);
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
