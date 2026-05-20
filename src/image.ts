/**
 * Image processing utilities for NanoClaw
 * Downloads images from URLs, resizes them, and converts to base64 for agent vision
 */
import https from 'https';
import sharp from 'sharp';
import { ImageAttachment } from './container-runner.js';
import { logger } from './logger.js';

/** Max dimension (width or height) for images passed to the agent */
const MAX_DIMENSION = 1024;

/** Download an image from a URL into a Buffer */
export async function downloadImage(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15_000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Resize an image buffer so neither dimension exceeds MAX_DIMENSION,
 * then return as a base64 ImageAttachment.
 */
export async function processImage(
  buffer: Buffer,
): Promise<ImageAttachment | null> {
  try {
    const resized = await sharp(buffer)
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();

    return {
      data: resized.toString('base64'),
      mediaType: 'image/jpeg',
    };
  } catch (err) {
    logger.warn({ err }, 'Image processing failed');
    return null;
  }
}
