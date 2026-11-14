// Server-only: never import this from a "use client" file (it reads the secret key).
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
  type ObjectCannedACL,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function env(name: string): string {
  return process.env[name]?.trim() || "";
}

let cached: ReturnType<typeof createClient> | null = null;

function createClient() {
  const key = env("DO_SPACES_KEY");
  const secret = env("DO_SPACES_SECRET");
  const region = env("DO_SPACES_REGION") || "blr1";
  const bucket = env("DO_SPACES_BUCKET");
  let endpoint =
    env("DO_SPACES_ENDPOINT") || `https://${region}.digitaloceanspaces.com`;
  const acl = (env("DO_SPACES_ACL") || "private") as ObjectCannedACL;

  if (!key || !secret || !bucket) {
    throw new Error(
      "Missing DigitalOcean Spaces credentials (DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_BUCKET)"
    );
  }

  // Normalize endpoint in case the bucket name was included in DO_SPACES_ENDPOINT
  endpoint = endpoint.replace(/\/+$/, "").replace(`://${bucket}.`, "://");

  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: false,
    // Required: otherwise presigned URLs carry an extra checksum and the browser PUT fails
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: key, secretAccessKey: secret },
  });

  const host = endpoint.replace(/^https?:\/\//, "");
  return { client, bucket, host, acl };
}

function spaces() {
  cached ??= createClient();
  return cached;
}

export function publicUrl(key: string): string {
  const { bucket, host } = spaces();
  return `https://${bucket}.${host}/${key}`;
}

export async function listKeysWithPrefix(prefix: string): Promise<Set<string>> {
  const { client, bucket } = spaces();
  const keys = new Set<string>();
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
    );
    for (const obj of res.Contents ?? []) if (obj.Key) keys.add(obj.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export type SpacesFile = {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  url: string; // presigned GET (1 hour), works for private files too
};

export async function listFiles(prefix: string): Promise<SpacesFile[]> {
  const { client, bucket } = spaces();
  const objects: Array<{ key: string; size: number; lastModified: Date }> = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
    );
    for (const o of res.Contents ?? []) {
      if (o.Key && !o.Key.endsWith("/")) {
        objects.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) });
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  objects.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return Promise.all(
    objects.map(async (o) => ({
      key: o.key,
      name: o.key.slice(prefix.length),
      size: o.size,
      lastModified: o.lastModified.toISOString(),
      url: await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: o.key }), {
        expiresIn: 3600,
      }),
    }))
  );
}

export async function startMultipartUpload(key: string, contentType: string) {
  const { client, bucket, acl } = spaces();
  const res = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ACL: acl,
    })
  );
  if (!res.UploadId) throw new Error("CreateMultipartUpload returned no UploadId");
  return res.UploadId;
}

export async function signUploadParts(key: string, uploadId: string, partNumbers: number[]) {
  const { client, bucket } = spaces();
  return Promise.all(
    partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await getSignedUrl(
        client,
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: 3600 }
      ),
    }))
  );
}

export async function listUploadedParts(key: string, uploadId: string) {
  const { client, bucket } = spaces();
  const parts: Array<{ partNumber: number; etag: string }> = [];
  let marker: string | undefined;
  do {
    const res = await client.send(
      new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker })
    );
    for (const p of res.Parts ?? []) {
      if (p.PartNumber && p.ETag) parts.push({ partNumber: p.PartNumber, etag: p.ETag });
    }
    marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
  } while (marker);
  return parts;
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>
) {
  const { client, bucket } = spaces();
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    })
  );
}

export async function abortMultipartUpload(key: string, uploadId: string) {
  const { client, bucket } = spaces();
  await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
}

export async function getSpacesFileSize(key: string): Promise<number> {
  const { client, bucket } = spaces();
  const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return res.ContentLength ?? 0;
}

export async function deleteSpacesFile(key: string) {
  const { client, bucket } = spaces();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
