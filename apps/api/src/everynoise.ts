import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export type EveryNoiseCatalog = {
  genres: string[];
  total: number;
  source: string;
};

const dataPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "data",
  "everynoise-genres.json"
);

let cachedCatalog: EveryNoiseCatalog | null = null;

export const loadEveryNoiseCatalog = (): EveryNoiseCatalog => {
  if (cachedCatalog) {
    return cachedCatalog;
  }

  const raw = fs.readFileSync(dataPath, "utf-8");
  const parsed = JSON.parse(raw) as { genres?: string[]; total?: number };
  const genres = Array.isArray(parsed.genres) ? parsed.genres : [];

  cachedCatalog = {
    genres,
    total: parsed.total ?? genres.length,
    source: "everynoise.com (Every Noise at Once, archived genre list)"
  };

  return cachedCatalog;
};

export const searchEveryNoiseGenres = (
  query: string,
  limit = 30
): { genres: string[]; total: number } => {
  const catalog = loadEveryNoiseCatalog();
  const normalized = query.trim().toLowerCase();
  const cap = Math.min(Math.max(limit, 1), 100);

  if (!normalized) {
    return { genres: catalog.genres.slice(0, cap), total: catalog.total };
  }

  const matches = catalog.genres.filter((genre) => genre.toLowerCase().includes(normalized));
  return { genres: matches.slice(0, cap), total: matches.length };
};

export const pickRandomEveryNoiseGenre = (): string => {
  const catalog = loadEveryNoiseCatalog();
  if (!catalog.genres.length) {
    return "electronic";
  }
  const index = Math.floor(Math.random() * catalog.genres.length);
  return catalog.genres[index] ?? "electronic";
};
