import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { MAX_STICKER_BYTES, STICKER_ID_PATTERN, STICKER_PREFIX, type PersonalSticker } from '@backspace/shared/src/stickers.js';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { getOurOrigin } from '../utils/federationAuth.js';
import { config } from '../config.js';
import { sendError } from '../utils/httpErrors.js';

// Separate from attachment cleanup: favorites and historical messages share immutable assets.
const assetPath = (id: string) => path.join(config.uploadDir, 'stickers', `${id}.webp`);
const tokenFor = (id: string) => `${STICKER_PREFIX}${getOurOrigin()}/api/stickers/assets/${id}.webp`;
const MAX_STICKER_MB = MAX_STICKER_BYTES / (1024 * 1024);

/** Thrown by `encodeSticker` for bytes that are not an accepted image. */
export class StickerImageError extends Error {
  constructor() {
    super('Not an accepted sticker image');
    this.name = 'StickerImageError';
  }
}

function collectSticker(input: { userId: string; id: string; name: string }): PersonalSticker {
  const db = getDb();
  db.insert(schema.personalStickers).values({
    userId: input.userId, stickerId: input.id, name: input.name, createdAt: Date.now(),
  }).onConflictDoNothing().run();
  const row = db.select().from(schema.personalStickers).where(and(
    eq(schema.personalStickers.userId, input.userId), eq(schema.personalStickers.stickerId, input.id),
  )).get()!;
  return { id: input.id, name: row.name, token: tokenFor(input.id) };
}

/** Re-encode instead of trusting MIME/extension; decode all frames to preserve animations safely. */
export async function encodeSticker(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_STICKER_BYTES) throw new StickerImageError();
  // Bound decoded pixels across animation frames, not only the compressed upload size.
  const MAX_DECODED_PIXELS = 16_777_216;
  try {
    const image = sharp(bytes, { animated: true, limitInputPixels: MAX_DECODED_PIXELS });
    const metadata = await image.metadata();
    if (!metadata.format || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format)) {
      throw new StickerImageError();
    }
    return await image.rotate().webp().toBuffer();
  } catch (error) {
    // Sharp's own messages name decoder internals; the caller only needs to know the image was refused.
    if (error instanceof StickerImageError) throw error;
    throw new StickerImageError();
  }
}

export async function stickerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stickers', { preHandler: authenticate }, async (request) => {
    const rows = getDb().select().from(schema.personalStickers)
      .where(eq(schema.personalStickers.userId, request.userId))
      .orderBy(desc(schema.personalStickers.createdAt)).all();
    return rows.map(row => ({ id: row.stickerId, name: row.name, token: tokenFor(row.stickerId) }));
  });

  // JSON uses the existing authenticated API client; the body limit accounts for base64 expansion.
  app.post<{ Body: { name: string; image: string } }>('/api/stickers', {
    preHandler: authenticate,
    bodyLimit: Math.ceil(MAX_STICKER_BYTES / 3) * 4 + 4096,
    schema: { body: { type: 'object', required: ['name', 'image'], additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, image: { type: 'string', minLength: 4 } } } },
  }, async (request, reply) => {
    const { name, image } = request.body;
    if (!name.trim()) return sendError(reply, 400, 'validation_failed');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image)) return sendError(reply, 400, 'validation_failed');
    const bytes = Buffer.from(image, 'base64');
    if (bytes.toString('base64') !== image) return sendError(reply, 400, 'validation_failed');
    // Only decode failures become validation errors; filesystem/database failures stay server errors.
    let encoded: Buffer;
    try { encoded = await encodeSticker(bytes); }
    catch (error) {
      if (error instanceof StickerImageError) return sendError(reply, 400, 'sticker_invalid_image', { maxMb: MAX_STICKER_MB });
      throw error;
    }
    const id = createHash('sha256').update(encoded).digest('hex');
    await mkdir(path.dirname(assetPath(id)), { recursive: true });
    // Publish atomically: concurrent duplicate uploads must never expose a truncated image.
    const temporaryPath = `${assetPath(id)}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, encoded);
    await rename(temporaryPath, assetPath(id));
    getDb().insert(schema.stickerAssets).values({ id, createdAt: Date.now() }).onConflictDoNothing().run();
    return collectSticker({ userId: request.userId, id, name: name.trim() });
  });

  app.post<{ Params: { id: string }; Body: { token: string; name: string } }>('/api/stickers/:id/collect', {
    preHandler: authenticate,
    schema: { body: { type: 'object', required: ['token', 'name'], additionalProperties: false, properties: {
      token: { type: 'string', maxLength: 2048 },
      // The collecting client names the entry in its own language; the server stores no wording of its own.
      name: { type: 'string', minLength: 1, maxLength: 100 },
    } },
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: STICKER_ID_PATTERN.source } } } },
  }, async (request, reply) => {
    if (request.body.token !== tokenFor(request.params.id)) return sendError(reply, 400, 'sticker_not_local');
    const asset = getDb().select().from(schema.stickerAssets).where(eq(schema.stickerAssets.id, request.params.id)).get();
    if (!asset) return sendError(reply, 404, 'sticker_not_found');
    const name = request.body.name.trim();
    if (!name) return sendError(reply, 400, 'validation_failed');
    return collectSticker({ userId: request.userId, id: asset.id, name });
  });

  app.delete<{ Params: { id: string } }>('/api/stickers/:id', { preHandler: authenticate }, async (request) => {
    getDb().delete(schema.personalStickers).where(and(
      eq(schema.personalStickers.userId, request.userId), eq(schema.personalStickers.stickerId, request.params.id),
    )).run();
    return { success: true };
  });

  // Same public-link access policy as existing uploads. Never accept a filesystem path or remote URL.
  app.get<{ Params: { filename: string } }>('/api/stickers/assets/:filename', async (request, reply) => {
    const id = request.params.filename.replace(/\.webp$/, '');
    if (!STICKER_ID_PATTERN.test(id) || request.params.filename !== `${id}.webp`) {
      return sendError(reply, 404, 'sticker_not_found');
    }
    const asset = getDb().select().from(schema.stickerAssets).where(eq(schema.stickerAssets.id, id)).get();
    // Resolve from the canonical stored key, never from the request path parameter.
    if (!asset || !STICKER_ID_PATTERN.test(asset.id)) return sendError(reply, 404, 'sticker_not_found');
    return reply.type('image/webp').header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=31536000, immutable').send(await readFile(assetPath(asset.id)));
  });
}
