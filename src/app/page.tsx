"use client";

import { useEffect, useRef, useState } from "react";
import { listUploadedFiles, uploadStep } from "@/app/actions/upload";
import type { SpacesFile } from "@/lib/spaces";
import {
  FILE_UPLOAD_MAX_BYTES,
  MiB,
  UPLOAD_PARALLEL_PARTS,
  UPLOAD_PART_BYTES,
} from "@/lib/uploadConfig";

const SIGN_BATCH = 10;
const MAX_ATTEMPTS = 5;

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 2 : 0)} ${units[i]}`;
}

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp", "ico"];
const VIDEO_EXT = ["mp4", "webm", "mov", "m4v", "ogv"];
const FILE_KINDS: Array<{ exts: string[]; label: string; color: string }> = [
  { exts: ["pdf"], label: "PDF", color: "bg-red-500/15 text-red-300" },
  { exts: ["mp3", "wav", "ogg", "m4a", "flac", "aac"], label: "AUDIO", color: "bg-purple-500/15 text-purple-300" },
  { exts: ["zip", "rar", "7z", "tar", "gz"], label: "ZIP", color: "bg-amber-500/15 text-amber-300" },
  { exts: ["doc", "docx", "txt", "rtf", "md"], label: "DOC", color: "bg-blue-500/15 text-blue-300" },
  { exts: ["xls", "xlsx", "csv"], label: "SHEET", color: "bg-emerald-500/15 text-emerald-300" },
  { exts: ["ppt", "pptx"], label: "SLIDES", color: "bg-orange-500/15 text-orange-300" },
  { exts: ["mkv", "avi", "wmv", "flv"], label: "VIDEO", color: "bg-pink-500/15 text-pink-300" },
];

function FileThumb({ name, url }: { name: string; url: string }) {
  const [failed, setFailed] = useState(false);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const box = "h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950";

  if (!failed && IMAGE_EXT.includes(ext)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- signed external URL, no optimization wanted
      <img src={url} alt={name} loading="lazy" onError={() => setFailed(true)} className={`${box} object-cover`} />
    );
  }
  if (!failed && VIDEO_EXT.includes(ext)) {
    return (
      // #t=0.5 makes the browser show a frame instead of a black box
      <video src={`${url}#t=0.5`} preload="metadata" muted playsInline onError={() => setFailed(true)} className={`${box} object-cover`} />
    );
  }

  const kind = FILE_KINDS.find((k) => k.exts.includes(ext));
  const label = kind?.label ?? (VIDEO_EXT.includes(ext) ? "VIDEO" : IMAGE_EXT.includes(ext) ? "IMG" : ext.slice(0, 4).toUpperCase() || "FILE");
  return (
    <div className={`${box} flex flex-col items-center justify-center gap-0.5 ${kind?.color ?? "text-zinc-400"}`}>
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
      <span className="text-[9px] font-semibold leading-none">{label}</span>
    </div>
  );
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true }
    );
  });
}

function putPart(
  url: string,
  body: Blob,
  signal: AbortSignal,
  onProgress: (loaded: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Part upload failed (HTTP ${xhr.status})`));
    xhr.onerror = () =>
      reject(new Error("Network error while uploading (check Spaces CORS)"));
    xhr.onabort = () => reject(abortError());
    xhr.onloadend = () => signal.removeEventListener("abort", onAbort);
    xhr.send(body);
  });
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
  const [files, setFiles] = useState<SpacesFile[]>([]);
  const [filesState, setFilesState] = useState<"loading" | "ready" | "error">(
    "loading"
  );

  const loadFiles = async () => {
    setFilesState("loading");
    try {
      const res = await listUploadedFiles();
      if (!res.ok) throw new Error(res.error);
      setFiles(res.files);
      setFilesState("ready");
    } catch (err) {
      console.error(err);
      setFilesState("error");
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadFiles();
  }, []);

  const abortRef = useRef<AbortController | null>(null);
  const userCancelledRef = useRef(false);
  const activeUploadRef = useRef<{ key: string; uploadId: string } | null>(
    null
  );

  useEffect(() => {
    if (status !== "uploading") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [status]);

  const selectFile = (selected: File | null) => {
    if (!selected || status === "uploading") return;
    const tooBig = selected.size > FILE_UPLOAD_MAX_BYTES;
    setFile(selected);
    setStatus(tooBig ? "error" : "idle");
    setProgress(0);
    setUploadedBytes(0);
    setSpeedMBps(0);
    setUploadedUrl("");
    setError(tooBig ? "File is larger than 1 GB." : "");
  };

  const abortOnServer = () => {
    const active = activeUploadRef.current;
    activeUploadRef.current = null;
    if (active) uploadStep({ type: "abort", ...active }).catch(() => {});
  };

  const handleUpload = async () => {
    if (!file || file.size > FILE_UPLOAD_MAX_BYTES) return;

    setStatus("uploading");
    setProgress(0);
    setUploadedBytes(0);
    setSpeedMBps(0);
    setUploadedUrl("");
    setError("");

    const controller = new AbortController();
    abortRef.current = controller;
    userCancelledRef.current = false;
    const signal = controller.signal;
    const startTime = Date.now();

    try {
      // 1. start
      const started = await uploadStep({
        type: "start",
        name: file.name,
        size: file.size,
        contentType: file.type || "application/octet-stream",
      });
      if (!started.ok) throw new Error(started.error);
      if (!("uploadId" in started)) throw new Error("Unexpected server response");
      const { key, uploadId } = started;
      activeUploadRef.current = { key, uploadId };
      if (signal.aborted) throw abortError();

      const partCount = Math.max(1, Math.ceil(file.size / UPLOAD_PART_BYTES));
      const urlCache = new Map<number, string>();
      const loadedPerPart = new Map<number, number>();

      const reportProgress = () => {
        let done = 0;
        for (const v of loadedPerPart.values()) done += v;
        const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
        setUploadedBytes(done);
        setProgress(Math.min(99, Math.floor((done / file.size) * 100)));
        setSpeedMBps(done / MiB / elapsedSec);
      };

      // 2. sign: presigned URLs in batches of 10, starting at the given part
      const signFrom = async (partNumber: number) => {
        const partNumbers: number[] = [];
        for (let n = partNumber; n <= partCount && partNumbers.length < SIGN_BATCH; n++) {
          partNumbers.push(n);
        }
        const signed = await uploadStep({ type: "sign", key, uploadId, partNumbers });
        if (!signed.ok) throw new Error(signed.error);
        if (!("urls" in signed)) throw new Error("Unexpected server response");
        for (const { partNumber: n, url } of signed.urls) urlCache.set(n, url);
      };

      // 3. PUT each part directly to Spaces, up to 5 attempts (1s, 2s, 3s… backoff)
      const uploadPart = async (partNumber: number) => {
        const start = (partNumber - 1) * UPLOAD_PART_BYTES;
        const end = Math.min(start + UPLOAD_PART_BYTES, file.size);
        // file.slice() reads lazily from disk, so the whole file is never loaded into RAM
        const chunk = file.slice(start, end);

        for (let attempt = 1; ; attempt++) {
          try {
            if (attempt > 1) urlCache.delete(partNumber); // fresh signed URL on every retry
            if (!urlCache.has(partNumber)) await signFrom(partNumber);
            await putPart(urlCache.get(partNumber)!, chunk, signal, (loaded) => {
              loadedPerPart.set(partNumber, loaded);
              reportProgress();
            });
            urlCache.delete(partNumber);
            loadedPerPart.set(partNumber, end - start);
            reportProgress();
            return;
          } catch (err) {
            if (signal.aborted || attempt >= MAX_ATTEMPTS) throw err;
            loadedPerPart.set(partNumber, 0);
            reportProgress();
            await sleep(1000 * attempt, signal);
          }
        }
      };

      const queue = Array.from({ length: partCount }, (_, i) => i + 1);
      let firstError: unknown = null;
      const worker = async () => {
        while (queue.length > 0 && !signal.aborted) {
          const partNumber = queue.shift()!;
          try {
            await uploadPart(partNumber);
          } catch (err) {
            firstError ??= err;
            controller.abort(); // one part failed for good: stop all other workers
            return;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_PARALLEL_PARTS, partCount) }, worker)
      );
      if (firstError) throw firstError;
      if (signal.aborted) throw abortError();

      // 4. complete (server reads ETags itself via ListParts)
      const completed = await uploadStep({ type: "complete", key, uploadId, partCount });
      if (!completed.ok) throw new Error(completed.error);
      if (!("url" in completed)) throw new Error("Unexpected server response");

      activeUploadRef.current = null;
      setUploadedBytes(file.size);
      setProgress(100);
      setUploadedUrl(completed.url);
      setStatus("done");
      loadFiles();
    } catch (err: unknown) {
      abortOnServer();
      if (userCancelledRef.current) {
        userCancelledRef.current = false;
        setStatus("idle");
        setProgress(0);
        setUploadedBytes(0);
        return;
      }
      console.error(err);
      setStatus("error");
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  };

  const handleCancel = () => {
    userCancelledRef.current = true;
    abortRef.current?.abort();
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 bg-zinc-950 text-zinc-100 p-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 shadow-xl space-y-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            DigitalOcean Spaces Uploader
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            Direct multipart upload to Spaces • Up to 1 GB
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
              <p className="text-xs text-zinc-500">Files up to 1 GB</p>
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
              disabled={!file || (file?.size ?? 0) > FILE_UPLOAD_MAX_BYTES}
              onClick={handleUpload}
              className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {status === "done" ? "Upload Again" : "Upload File"}
            </button>
          )}
        </div>
      </div>

      {/* Uploaded Files List */}
      <section className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">
            Uploaded files{filesState === "ready" ? ` (${files.length})` : ""}
          </h2>
          <button
            type="button"
            onClick={loadFiles}
            disabled={filesState === "loading"}
            className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
          >
            {filesState === "loading" ? "Loading…" : "Refresh"}
          </button>
        </div>

        {filesState === "error" && (
          <p className="text-xs text-red-300">Could not load the file list.</p>
        )}
        {filesState === "ready" && files.length === 0 && (
          <p className="text-xs text-zinc-500">No files uploaded yet.</p>
        )}

        {files.length > 0 && (
          <ul className="divide-y divide-zinc-800 max-h-80 overflow-y-auto">
            {files.map((f) => (
              <li key={f.key} className="flex items-center gap-3 py-2.5">
                <FileThumb name={f.name} url={f.url} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-zinc-100" title={f.name}>
                    {f.name}
                  </p>
                  <p className="text-xs font-mono text-zinc-500">
                    {formatBytes(f.size)} •{" "}
                    {new Date(f.lastModified).toLocaleString()}
                  </p>
                </div>
                <a
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
                >
                  Open
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
