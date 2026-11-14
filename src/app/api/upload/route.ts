import { NextResponse } from "next/server";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSpacesClient } from "@/lib/spaces";

function makeObjectKey(filename: string): string {
  const safeName =
    filename.replace(/[/\\]/g, "_").replace(/[^\w.\- ()]/g, "_").trim() ||
    "file";
  return `uploads/${Date.now()}-${safeName}`;
}

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action");
    const { client, bucket, host, acl } = getSpacesClient();

    // 1. Small file (< 5 MB): single backend PutObject upload
    if (action === "single") {
      const filename = decodeURIComponent(
        req.headers.get("x-file-name") || "file"
      );
      const contentType =
        req.headers.get("x-content-type") || "application/octet-stream";
      const key = makeObjectKey(filename);
      const buffer = Buffer.from(await req.arrayBuffer());

      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
          ACL: acl,
        })
      );

      return NextResponse.json({
        key,
        url: `https://${bucket}.${host}/${key}`,
      });
    }

    // 2. Heavy file (>= 5 MB, no upper limit): Initiate Multipart Upload
    if (action === "init") {
      const { filename, contentType } = await req.json();
      const key = makeObjectKey(filename || "file");

      const res = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: contentType || "application/octet-stream",
          ACL: acl,
        })
      );

      return NextResponse.json({ uploadId: res.UploadId, key });
    }

    // 3. Upload a single chunk through the backend to DigitalOcean Spaces
    if (action === "part") {
      const key = searchParams.get("key") || "";
      const uploadId = searchParams.get("uploadId") || "";
      const partNumber = Number(searchParams.get("partNumber"));

      if (!key || !uploadId || !partNumber) {
        return NextResponse.json(
          { error: "Missing key, uploadId, or partNumber" },
          { status: 400 }
        );
      }

      const buffer = Buffer.from(await req.arrayBuffer());

      let lastErr: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await client.send(
            new UploadPartCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
              Body: buffer,
            })
          );
          return NextResponse.json({ partNumber, etag: res.ETag });
        } catch (err) {
          lastErr = err;
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        }
      }
      throw lastErr;
    }

    // 4. Complete Multipart Upload on DigitalOcean Spaces
    if (action === "complete") {
      const { key, uploadId, parts } = (await req.json()) as {
        key: string;
        uploadId: string;
        parts: Array<{ PartNumber: number; ETag: string }>;
      };

      const sortedParts = [...parts].sort(
        (a, b) => a.PartNumber - b.PartNumber
      );

      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: sortedParts },
        })
      );

      return NextResponse.json({
        key,
        url: `https://${bucket}.${host}/${key}`,
      });
    }

    // 5. Abort cancelled Multipart Upload so no orphan chunks remain
    if (action === "abort") {
      const { key, uploadId } = await req.json();
      if (key && uploadId) {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
          })
        );
      }
      return NextResponse.json({ aborted: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
