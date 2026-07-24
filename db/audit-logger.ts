import fs from "fs";
import path from "path";

const AUDIT_FILE = path.join(__dirname, "..", "priv-docs", "audit.jsonl");

interface AuditEntry {
  timestamp: string;
  requestId: string;
  stage: string;
  data: Record<string, any>;
}

function ensureAuditFile() {
  const dir = path.dirname(AUDIT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function auditLog(requestId: string, stage: string, data: Record<string, any>) {
  ensureAuditFile();

  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    requestId,
    stage,
    data,
  };

  fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
  console.log(`[audit] ${stage}: ${JSON.stringify(data).slice(0, 100)}`);
}

export function getAuditLog(requestId: string): AuditEntry[] {
  if (!fs.existsSync(AUDIT_FILE)) return [];

  const lines = fs.readFileSync(AUDIT_FILE, "utf-8").split("\n").filter(Boolean);
  return lines
    .map(line => {
      try {
        return JSON.parse(line) as AuditEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is AuditEntry => e !== null && e.requestId === requestId);
}
