import fs from "node:fs";
import path from "node:path";
import { S3Client, type ObjectCannedACL } from "@aws-sdk/client-s3";

function readEnvValue(name: string): string {
  // Read live from .env.local if present so editing .env.local doesn't require a restart
  try {
    const envPath = path.join(process.cwd(), ".env.local");
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq !== -1 && line.slice(0, eq).trim() === name) {
          return line
            .slice(eq + 1)
            .trim()
            .replace(/^['"]|['"]$/g, "");
        }
      }
    }
  } catch {
    // Fallback to process.env
  }
  return process.env[name]?.trim() || "";
}

export function getSpacesClient() {
  const key = readEnvValue("DO_SPACES_KEY");
  const secret = readEnvValue("DO_SPACES_SECRET");
  const region = readEnvValue("DO_SPACES_REGION") || "blr1";
  const bucket = readEnvValue("DO_SPACES_BUCKET");
  let endpoint =
    readEnvValue("DO_SPACES_ENDPOINT") ||
    `https://${region}.digitaloceanspaces.com`;
  const acl = (readEnvValue("DO_SPACES_ACL") || "private") as ObjectCannedACL;

  if (
    !key ||
    !secret ||
    !bucket ||
    key === "your_spaces_access_key" ||
    secret === "your_spaces_secret_key"
  ) {
    throw new Error(
      "Missing DigitalOcean Spaces credentials. Please set DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_REGION, DO_SPACES_ENDPOINT, and DO_SPACES_BUCKET in .env.local"
    );
  }

  // Normalize endpoint in case bucket name was accidentally included in DO_SPACES_ENDPOINT
  endpoint = endpoint.replace(/\/+$/, "");
  const bucketPrefix = `://${bucket}.`;
  if (endpoint.includes(bucketPrefix)) {
    endpoint = endpoint.replace(bucketPrefix, "://");
  }

  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: false,
    // Ensures clean compatibility with DigitalOcean Spaces (Ceph S3)
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: key,
      secretAccessKey: secret,
    },
  });

  const host = endpoint.replace(/^https?:\/\//, "");
  return { client, bucket, region, endpoint, host, acl };
}
