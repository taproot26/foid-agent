import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const AGENT_CODE_DIR = path.join(__dirname, "..", "..", "agent-code");

function ensureAgentCodeDir() {
  if (!fs.existsSync(AGENT_CODE_DIR)) fs.mkdirSync(AGENT_CODE_DIR, { recursive: true });
}

function resolveSafePath(filePath: string): string | null {
  const resolved = path.resolve(AGENT_CODE_DIR, filePath);
  const normalizedRoot = path.resolve(AGENT_CODE_DIR) + path.sep;
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(AGENT_CODE_DIR)) {
    return null;
  }
  return resolved;
}

export async function writeCircom(params: Record<string, any>): Promise<string> {
  const filename: string = params.filename;
  const code: string = params.code;

  if (!filename || !code) return "missing filename or code";
  if (!filename.endsWith(".circom")) return "filename must end with .circom";

  const target = resolveSafePath(filename);
  if (!target) return "blocked: filename must stay inside agent-code directory";

  try {
    ensureAgentCodeDir();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, code);
    return `wrote ${filename} to agent-code/`;
  } catch (e: any) {
    return `write error: ${e.message}`;
  }
}

export async function compileCircom(params: Record<string, any>): Promise<string> {
  const filename: string = params.filename;
  if (!filename) return "missing filename parameter";

  const target = resolveSafePath(filename);
  if (!target) return "blocked: filename must stay inside agent-code directory";
  if (!fs.existsSync(target)) return `file not found: ${filename}`;

  try {
    // try to compile with circom
    const outputDir = path.dirname(target);
    const cmd = `cd "${outputDir}" && circom ${path.basename(target)} --r1cs --wasm 2>&1`;
    const output = execSync(cmd, { encoding: "utf-8", timeout: 15000 }).trim();
    return `compiled successfully:\n${output}`;
  } catch (e: any) {
    const error = e.message || String(e);
    // Check if circom is installed
    if (error.includes("command not found") || error.includes("not found")) {
      return `circom not installed. Install with: npm install -g circom`;
    }
    return `compilation error:\n${error.slice(0, 500)}`;
  }
}
