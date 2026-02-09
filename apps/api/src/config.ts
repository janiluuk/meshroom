export type AppConfig = {
  server: {
    port: number;
    host: string;
  };
  livekit: {
    url: string;
    apiUrl: string;
    apiKey: string;
    apiSecret: string;
  };
  minio: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
    region: string;
    forcePathStyle: boolean;
    publicUrl: string;
  };
  programOutUrl: string;
  masterKey: string;
};

const parseBoolean = (value: string | undefined, defaultValue: boolean) => {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no"].includes(normalized)) {
    return false;
  }
  return defaultValue;
};

const parseNumber = (value: string | undefined, defaultValue: number) => {
  if (!value) {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const livekitUrl = env.LIVEKIT_URL ?? "ws://localhost:7880";
  const livekitApiUrl = env.LIVEKIT_API_URL ?? livekitUrl.replace(/^ws/, "http");

  const minioEndpoint = env.MINIO_ENDPOINT ?? "http://localhost:9000";

  return {
    server: {
      port: parseNumber(env.PORT, 4000),
      host: env.HOST ?? "0.0.0.0"
    },
    livekit: {
      url: livekitUrl,
      apiUrl: livekitApiUrl,
      apiKey: env.LIVEKIT_API_KEY ?? "",
      apiSecret: env.LIVEKIT_API_SECRET ?? ""
    },
    minio: {
      endpoint: minioEndpoint,
      accessKey: env.MINIO_ACCESS_KEY ?? "",
      secretKey: env.MINIO_SECRET_KEY ?? "",
      bucket: env.MINIO_BUCKET ?? "recordings",
      region: env.MINIO_REGION ?? "us-east-1",
      forcePathStyle: parseBoolean(env.MINIO_FORCE_PATH_STYLE, true),
      publicUrl: env.MINIO_PUBLIC_URL ?? minioEndpoint
    },
    programOutUrl: env.PROGRAM_OUT_RTMP_URL ?? "",
    masterKey: env.MASTER_KEY ?? env.MASTER_API_KEY ?? ""
  };
};
