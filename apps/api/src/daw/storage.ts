import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";
import type { ProjectAnalysisManifest } from "./types.js";

export type DawStorageConfig = {
  bucket: string;
  publicUrl: string;
};

const streamToBuffer = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

export const revisionOriginalKey = (projectId: string, revisionId: string, ext: string) =>
  `projects/${projectId}/revisions/${revisionId}/original.${ext}`;

export const revisionAnalysisKey = (projectId: string, revisionId: string) =>
  `projects/${projectId}/revisions/${revisionId}/analysis.json`;

export const createDawStorage = (s3: S3Client, config: DawStorageConfig) => ({
  putOriginal: async (key: string, body: Buffer, contentType: string) => {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType
      })
    );
  },
  putAnalysis: async (key: string, analysis: ProjectAnalysisManifest) => {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: JSON.stringify(analysis, null, 2),
        ContentType: "application/json"
      })
    );
  },
  getAnalysis: async (key: string): Promise<ProjectAnalysisManifest | null> => {
    try {
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key
        })
      );
      const buffer = await streamToBuffer(response.Body as Readable);
      return JSON.parse(buffer.toString("utf-8")) as ProjectAnalysisManifest;
    } catch {
      return null;
    }
  },
  getOriginalBuffer: async (key: string): Promise<Buffer | null> => {
    try {
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key
        })
      );
      return streamToBuffer(response.Body as Readable);
    } catch {
      return null;
    }
  },
  presignedDownloadUrl: async (key: string, expiresInSeconds = 3600) => {
    return getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: key
      }),
      { expiresIn: expiresInSeconds }
    );
  },
  publicUrlForKey: (key: string) => {
    const base = config.publicUrl.replace(/\/$/, "");
    return `${base}/${config.bucket}/${key}`;
  }
});

export type DawStorage = ReturnType<typeof createDawStorage>;
