// Shared by the browser (page.tsx) and the server (actions/upload.ts).

export const MiB = 1024 * 1024;
export const FILE_UPLOAD_MAX_BYTES = 1024 * MiB; // 1 GB
export const UPLOAD_PART_BYTES = 10 * MiB; // Spaces minimum is 5 MiB (except the last part)
export const UPLOAD_PARALLEL_PARTS = 1; // 1 on slow networks, 2-3 on fast ones
export const UPLOAD_MAX_PARTS = Math.ceil(FILE_UPLOAD_MAX_BYTES / UPLOAD_PART_BYTES);
export const UPLOAD_FOLDER = "uploads";

export type UploadStep =
  | { type: "start"; name: string; size: number; contentType: string }
  | { type: "sign"; key: string; uploadId: string; partNumbers: number[] }
  | { type: "complete"; key: string; uploadId: string; partCount: number }
  | { type: "abort"; key: string; uploadId: string };

export type UploadStepResult =
  | { ok: true; key: string; uploadId: string } // start
  | { ok: true; urls: Array<{ partNumber: number; url: string }> } // sign
  | { ok: true; key: string; url: string; size: number } // complete
  | { ok: true } // abort
  | { ok: false; error: string };
