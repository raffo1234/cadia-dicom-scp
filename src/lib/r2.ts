import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";

const endpoint = process.env.CLOUDFLARE_R2_ENDPOINT;
const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.CLOUDFLARE_R2_BUCKET ?? "dicoms";

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
  folder: string,  // hospital folder e.g. "CADIA.PE"
  key: string,     // dicom/<study>/<series>/<sop>.dcm
  body: Buffer,
): Promise<string> => {
  const fullKey = `${folder}/${key}`;

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: fullKey,
      Body: body,
      ContentType: "application/dicom",
    }),
  );

  return fullKey; // e.g. "CADIA.PE/dicom/<study>/<series>/<sop>.dcm"
};

export const downloadFromR2 = async (
  folder: string,
  key: string,
): Promise<Buffer> => {
  const bucket = process.env.CLOUDFLARE_R2_BUCKET ?? "dicoms";
  const result = await r2.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: `${folder}/${key}`,
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

