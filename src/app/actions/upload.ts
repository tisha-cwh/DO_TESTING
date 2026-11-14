"use server";

import {
  abortMultipartUpload,
  completeMultipartUpload,
  deleteSpacesFile,
  getSpacesFileSize,
  listKeysWithPrefix,
  listUploadedParts,
  publicUrl,
  signUploadParts,
  startMultipartUpload,
} from "@/lib/spaces";
import {
  FILE_UPLOAD_MAX_BYTES,
  UPLOAD_FOLDER,
  UPLOAD_MAX_PARTS,
  type UploadStep,
  type UploadStepResult,
} from "@/lib/uploadConfig";


function cleanName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  return cleaned.replace(/^[-.]+/, "").slice(0, 200) || "file";
}

async function uniqueKey(fileName: string): Promise<string> {
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  const existing = await listKeysWithPrefix(`${UPLOAD_FOLDER}/${base}`);
  let candidate = `${UPLOAD_FOLDER}/${fileName}`;
  for (let i = 1; existing.has(candidate); i++) {
    candidate = `${UPLOAD_FOLDER}/${base}-${i}${ext}`;
  }
  return candidate;
}

function isValidKey(key: unknown): key is string {
  if (typeof key !== "string" || !key.startsWith(`${UPLOAD_FOLDER}/`)) return false;
  const rest = key.slice(UPLOAD_FOLDER.length + 1);
  return rest.length > 0 && !rest.includes("/");
}

function isValidUploadId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length < 1024;
}

function isValidPartNumber(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= UPLOAD_MAX_PARTS;
}

export async function uploadStep(step: UploadStep): Promise<UploadStepResult> {
  try {
    switch (step.type) {
      case "start": {
        const { name, size, contentType } = step;
        if (!Number.isFinite(size) || size <= 0) return { ok: false, error: "File is empty." };
        if (size > FILE_UPLOAD_MAX_BYTES) return { ok: false, error: "File is larger than 1 GB." };
        const key = await uniqueKey(cleanName(String(name)));
        const type =
          typeof contentType === "string" && contentType ? contentType : "application/octet-stream";
        const uploadId = await startMultipartUpload(key, type);
        return { ok: true, key, uploadId };
      }

      case "sign": {
        const { key, uploadId, partNumbers } = step;
        if (!isValidKey(key) || !isValidUploadId(uploadId)) {
          return { ok: false, error: "Invalid upload." };
        }
        if (
          !Array.isArray(partNumbers) ||
          partNumbers.length === 0 ||
          partNumbers.length > 50 ||
          !partNumbers.every(isValidPartNumber)
        ) {
          return { ok: false, error: "Invalid part numbers." };
        }
        const urls = await signUploadParts(key, uploadId, partNumbers);
        return { ok: true, urls };
      }

      case "complete": {
        const { key, uploadId, partCount } = step;
        if (!isValidKey(key) || !isValidUploadId(uploadId) || !isValidPartNumber(partCount)) {
          return { ok: false, error: "Invalid upload." };
        }
        const uploaded = await listUploadedParts(key, uploadId);
        const byNumber = new Map(uploaded.map((p) => [p.partNumber, p]));
        const parts = [];
        for (let n = 1; n <= partCount; n++) {
          const part = byNumber.get(n);
          if (!part) return { ok: false, error: `Part ${n} is missing. Please retry the upload.` };
          parts.push(part);
        }
        await completeMultipartUpload(key, uploadId, parts);

        const size = await getSpacesFileSize(key);
        if (size > FILE_UPLOAD_MAX_BYTES) {
          await deleteSpacesFile(key);
          return { ok: false, error: "File is larger than 1 GB." };
        }
        return { ok: true, key, url: publicUrl(key), size };
      }

      case "abort": {
        const { key, uploadId } = step;
        if (!isValidKey(key) || !isValidUploadId(uploadId)) {
          return { ok: false, error: "Invalid upload." };
        }
        await abortMultipartUpload(key, uploadId);
        return { ok: true };
      }

      default:
        return { ok: false, error: "Unknown upload step." };
    }
  } catch (err) {
    console.error(`[uploadStep:${(step as { type?: string })?.type}]`, err);
    return { ok: false, error: "Upload failed on the server. Please try again." };
  }
}
