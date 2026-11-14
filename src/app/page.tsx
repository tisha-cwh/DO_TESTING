"use client";

import { useRef, useState } from "react";

const MiB = 1024 * 1024;
const MIN_MULTIPART_SIZE = 5 * MiB; // S3 / DO Spaces minimum part size
const CONCURRENCY = 3; // Parallel chunk uploads to backend

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 2 : 0)} ${units[i]}`;
}

function getChunkSize(fileSize: number): number {
  // Base 8 MB chunks; automatically scales up if file > 75 GB so total parts stay < 9,500 (no size limit)
  const base = 8 * MiB;
  const minForCeiling = Math.ceil(fileSize / 9500);
  return Math.ceil(Math.max(base, minForCeiling) / (5 * MiB)) * (5 * MiB);
}

export default function HomePage() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<
    "idle" | "uploading" | "done" | "error"
  >("idle");
  const [progress, setProgress] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [speedMBps, setSpeedMBps] = useState(0);
  const [uploadedUrl, setUploadedUrl] = useState("");
  const [error, setError] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const activeUploadRef = useRef<{ key: string; uploadId: string } | null>(
    null
  );

  const selectFile = (selected: File | null) => {
    if (!selected || status === "uploading") return;
    setFile(selected);
    setStatus("idle");
    setProgress(0);
    setUploadedBytes(0);
    setSpeedMBps(0);
    setUploadedUrl("");
    setError("");
  };

  const handleUpload = async () => {
    if (!file) return;

    setStatus("uploading");
    setProgress(0);
    setUploadedBytes(0);
    setSpeedMBps(0);
    setUploadedUrl("");
    setError("");

    const controller = new AbortController();
    abortRef.current = controller;
    const startTime = Date.now();

    try {
      // Small files (< 5 MB): single backend upload
      if (file.size < MIN_MULTIPART_SIZE) {
        const res = await fetch("/api/upload?action=single", {
          method: "POST",
          headers: {
            "x-file-name": encodeURIComponent(file.name),
            "x-content-type": file.type || "application/octet-stream",
          },
          body: file,
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");

        setUploadedBytes(file.size);
        setProgress(100);
        setUploadedUrl(data.url);
        setStatus("done");
        return;
      }

      // Heavy files (2-3 GB+, no limit): Chunked Multipart Upload via Next.js Backend
      const initRes = await fetch("/api/upload?action=init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
        }),
        signal: controller.signal,
      });
      const initData = await initRes.json();
      if (!initRes.ok) throw new Error(initData.error || "Failed to start upload");

      const { uploadId, key } = initData as { uploadId: string; key: string };
      activeUploadRef.current = { key, uploadId };

      const chunkSize = getChunkSize(file.size);
      const totalParts = Math.ceil(file.size / chunkSize);
      const queue = Array.from({ length: totalParts }, (_, i) => i + 1);
      const completedParts: Array<{ PartNumber: number; ETag: string }> = [];
      let totalDoneBytes = 0;

      const worker = async () => {
        while (queue.length > 0) {
          const partNumber = queue.shift();
          if (!partNumber) return;

          const start = (partNumber - 1) * chunkSize;
          const end = Math.min(start + chunkSize, file.size);
          // file.slice() streams from disk without loading the multi-GB file into RAM
          const chunk = file.slice(start, end);

          const partRes = await fetch(
            `/api/upload?action=part&key=${encodeURIComponent(
              key
            )}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
            {
              method: "POST",
              body: chunk,
              signal: controller.signal,
            }
          );

          const partData = await partRes.json();
          if (!partRes.ok) {
            throw new Error(partData.error || `Failed on part ${partNumber}`);
          }

          completedParts.push({
            PartNumber: partNumber,
            ETag: partData.etag,
          });

          totalDoneBytes += end - start;
          const pct = Math.min(99, Math.round((totalDoneBytes / file.size) * 100));
          const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);

          setUploadedBytes(totalDoneBytes);
          setProgress(pct);
          setSpeedMBps(totalDoneBytes / MiB / elapsedSec);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, totalParts) }, () => worker())
      );

      // Finalize Multipart Upload on DigitalOcean Spaces
      const completeRes = await fetch("/api/upload?action=complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, uploadId, parts: completedParts }),
        signal: controller.signal,
      });
      const completeData = await completeRes.json();
      if (!completeRes.ok) {
        throw new Error(completeData.error || "Failed to complete upload");
      }

      activeUploadRef.current = null;
      setUploadedBytes(file.size);
      setProgress(100);
      setUploadedUrl(completeData.url);
      setStatus("done");
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        setStatus("idle");
        setProgress(0);
        setUploadedBytes(0);
        return;
      }
      setStatus("error");
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  const handleCancel = async () => {
    abortRef.current?.abort();
    const active = activeUploadRef.current;
    activeUploadRef.current = null;
    if (active) {
      fetch("/api/upload?action=abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(active),
      }).catch(() => {});
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100 p-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 shadow-xl space-y-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            DigitalOcean Spaces Uploader
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            Backend chunked multipart upload • No file size limit
          </p>
        </div>

        {/* Minimal File Picker / Dropzone */}
        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            selectFile(e.dataTransfer.files?.[0] ?? null);
          }}
          className={`flex flex-col items-center justify-center rounded-xl border border-dashed p-6 text-center transition ${
            status === "uploading"
              ? "border-zinc-800 opacity-60 cursor-not-allowed"
              : "border-zinc-700 hover:border-zinc-500 cursor-pointer bg-zinc-950/40"
          }`}
        >
          <input
            type="file"
            className="hidden"
            disabled={status === "uploading"}
            onChange={(e) => selectFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="space-y-1 max-w-full">
              <p className="text-sm font-medium text-zinc-100 truncate max-w-xs">
                {file.name}
              </p>
              <p className="text-xs text-zinc-400 font-mono">
                {formatBytes(file.size)}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-sm text-zinc-300">
                Click or drop a file here
              </p>
              <p className="text-xs text-zinc-500">
                Supports 2–3 GB+ heavy files with no limit
              </p>
            </div>
          )}
        </label>

        {/* Progress Bar */}
        {(status === "uploading" || status === "done") && file && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-mono text-zinc-400">
              <span>
                {formatBytes(uploadedBytes)} / {formatBytes(file.size)}
              </span>
              <span>
                {status === "uploading" && speedMBps > 0
                  ? `${speedMBps.toFixed(1)} MB/s • `
                  : ""}
                {progress}%
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className={`h-full transition-all duration-200 ${
                  status === "done" ? "bg-emerald-500" : "bg-blue-500"
                }`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Error Message */}
        {status === "error" && error && (
          <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        {/* Uploaded Result */}
        {status === "done" && uploadedUrl && (
          <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-3 space-y-1">
            <p className="text-xs font-medium text-emerald-400">
              Upload complete
            </p>
            <p className="text-xs text-zinc-300 font-mono break-all">
              {uploadedUrl}
            </p>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-2">
          {status === "uploading" ? (
            <button
              type="button"
              onClick={handleCancel}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 transition"
            >
              Cancel Upload
            </button>
          ) : (
            <button
              type="button"
              disabled={!file}
              onClick={handleUpload}
              className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {status === "done" ? "Upload Again" : "Upload File"}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
