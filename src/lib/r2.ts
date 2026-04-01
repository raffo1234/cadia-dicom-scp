import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";

const endpoint = process.env.CLOUDFLARE_R2_ENDPOINT;
const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;

if (!endpoint || !accessKeyId || !secretAccessKey) {
  throw new Error(
    "Missing CLOUDFLARE_R2_ENDPOINT, CLOUDFLARE_R2_ACCESS_KEY_ID or CLOUDFLARE_R2_SECRET_ACCESS_KEY",
  );
}

export const r2 = new S3Client({
  region: "auto",
  endpoint,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

export const uploadToR2 = async (
  bucket: string,
  key: string,
  body: Buffer,
): Promise<string> => {
  await r2.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/dicom",
    }),
  );

  // Return the public URL — same pattern as your existing storage
  const storageDomain = process.env.STORAGE_DOMAIN?.replace(/\/$/, "") ?? "";
  return `${storageDomain}/${key}`;
};

export const downloadFromR2 = async (
  bucket: string,
  key: string,
): Promise<Buffer> => {
  const result = await r2.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
 
  if (!result.Body) {
    throw new Error(`Empty body from R2 for key: ${key}`);
  }
 
  // Convert readable stream to Buffer
  const stream = result.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};