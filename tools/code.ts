import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const TEMP_DIR = path.join(__dirname, "..", ".temp");
const AGENT_CODE_DIR = path.join(__dirname, "..", "..", "agent-code");

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function ensureAgentCodeDir() {
  if (!fs.existsSync(AGENT_CODE_DIR)) fs.mkdirSync(AGENT_CODE_DIR, { recursive: true });
}

function resolveInAgentCodeDir(relPath: string): string | null {
  const resolved = path.resolve(AGENT_CODE_DIR, relPath);
  const normalizedRoot = path.resolve(AGENT_CODE_DIR) + path.sep;
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(AGENT_CODE_DIR)) {
    return null;
  }
  return resolved;
}

const CODE_BLOCKED = ["rm -rf", "sudo", ":(){:|:&", "fork()", "drop table", "delete from", "> /", "sudo rm"];

export async function writeCode(params: Record<string, any>): Promise<string> {
  const filename: string = params.filename;
  const code: string = params.code;
  if (!filename || code === undefined) return "missing filename or code parameter";

  const target = resolveInAgentCodeDir(filename);
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

export async function runAgentCode(params: Record<string, any>): Promise<string> {
  const cmd: string = params.cmd;
  if (!cmd) return "missing cmd parameter";

  if (CODE_BLOCKED.some(b => cmd.toLowerCase().includes(b))) {
    return "command blocked for safety";
  }
  if (cmd.includes("..") || cmd.includes("~") || / \/(?!dev\/null)/.test(cmd)) {
    return "command blocked: paths must stay inside agent-code directory";
  }

  try {
    ensureAgentCodeDir();
    const output = execSync(cmd, { encoding: "utf-8", timeout: 10000, cwd: AGENT_CODE_DIR }).trim();
    return output.slice(0, 1500);
  } catch (e: any) {
    return `error: ${e.message}`.slice(0, 500);
  }
}

export async function shellExec(params: Record<string, any>): Promise<string> {
  const cmd: string = params.cmd;
  if (!cmd) return "missing cmd parameter";

  const blocked = ["rm -rf", "sudo", ":(){:|:&", "fork()", "drop table", "delete from"];
  if (blocked.some(b => cmd.toLowerCase().includes(b))) {
    return "command blocked for safety";
  }

  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
    return output.slice(0, 1000);
  } catch (e: any) {
    return `error: ${e.message}`.slice(0, 500);
  }
}

export async function nodeExec(params: Record<string, any>): Promise<string> {
  const code: string = params.code;
  if (!code) return "missing code parameter";

  try {
    const result = eval(code);
    return String(result).slice(0, 1000);
  } catch (e: any) {
    return `eval error: ${e.message}`;
  }
}

export async function rustExec(params: Record<string, any>): Promise<string> {
  const code: string = params.code;
  if (!code) return "missing code parameter";

  ensureTempDir();
  const tempFile = path.join(TEMP_DIR, "temp.rs");
  const outFile = path.join(TEMP_DIR, "temp");

  try {
    fs.writeFileSync(tempFile, code);
    execSync(`rustc ${tempFile} -o ${outFile}`, { timeout: 10000 });
    const output = execSync(outFile, { encoding: "utf-8", timeout: 5000 }).trim();
    return output.slice(0, 1000);
  } catch (e: any) {
    return `rust error: ${e.message}`.slice(0, 500);
  }
}

export async function htmlPreview(params: Record<string, any>): Promise<string> {
  const html: string = params.html;
  const css: string = params.css || "";
  const js: string = params.js || "";

  if (!html) return "missing html parameter";

  ensureTempDir();
  const filePath = path.join(TEMP_DIR, "preview.html");

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    ${css}
  </style>
</head>
<body>
  ${html}
  <script>
    ${js}
  </script>
</body>
</html>`;

  fs.writeFileSync(filePath, fullHtml);
  return `Preview saved to .temp/preview.html`;
}

function resolveInProject(relPath: string): string | null {
  const projectRoot = path.join(__dirname, "..");
  const resolved = path.resolve(projectRoot, relPath);
  const normalizedRoot = path.resolve(projectRoot) + path.sep;
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(projectRoot)) {
    return null;
  }
  return resolved;
}

export async function readFile(params: Record<string, any>): Promise<string> {
  const filepath: string = params.filepath;
  if (!filepath) return "missing filepath parameter";

  const resolved = resolveInProject(filepath);
  if (!resolved) return "blocked: filepath must stay inside project directory";

  try {
    const content = fs.readFileSync(resolved, "utf-8");
    const lines = content.split("\n");
    // return lines with their line numbers (1-indexed)
    return lines.map((line, i) => `${i + 1}|${line}`).join("\n");
  } catch (e: any) {
    return `read error: ${e.message}`;
  }
}

export async function findLine(params: Record<string, any>): Promise<string> {
  const filepath: string = params.filepath;
  const query: string = params.query;
  if (!filepath || !query) return "missing filepath or query parameter";

  const resolved = resolveInProject(filepath);
  if (!resolved) return "blocked: filepath must stay inside project directory";

  try {
    const content = fs.readFileSync(resolved, "utf-8");
    const lines = content.split("\n");
    const matches = lines
      .map((line, i) => ({ lineNum: i + 1, line }))
      .filter(({ line }) => line.includes(query));
    if (matches.length === 0) return `no matches for "${query}"`;
    if (matches.length === 1) return `found at line ${matches[0].lineNum}`;
    return `found ${matches.length} matches:\n${matches.map(m => `  line ${m.lineNum}: ${m.line}`).join("\n")}`;
  } catch (e: any) {
    return `search error: ${e.message}`;
  }
}

export async function editLines(params: Record<string, any>): Promise<string> {
  const filepath: string = params.filepath;
  const startLine: number = parseInt(params.start_line);
  const endLine: number = parseInt(params.end_line);
  const newCode: string = params.new_code;

  if (!filepath || isNaN(startLine) || isNaN(endLine) || newCode === undefined) {
    return "missing filepath, start_line, end_line, or new_code parameter";
  }

  const resolved = resolveInProject(filepath);
  if (!resolved) return "blocked: filepath must stay inside project directory";

  try {
    const content = fs.readFileSync(resolved, "utf-8");
    const lines = content.split("\n");

    if (startLine < 1 || endLine < 1 || startLine > lines.length || endLine > lines.length) {
      return `invalid line range: file has ${lines.length} lines, requested [${startLine}, ${endLine}]`;
    }
    if (startLine > endLine) {
      return `invalid range: start_line (${startLine}) > end_line (${endLine})`;
    }

    // replace lines [startLine, endLine] (convert to 0-indexed)
    const newLines = [
      ...lines.slice(0, startLine - 1),
      ...newCode.split("\n"),
      ...lines.slice(endLine),
    ];

    fs.writeFileSync(resolved, newLines.join("\n"));
    return `edited ${filepath}: replaced lines ${startLine}-${endLine}`;
  } catch (e: any) {
    return `edit error: ${e.message}`;
  }
}

export async function checkFrontend(_params: Record<string, any>): Promise<string> {
  const frontendDir = path.join(__dirname, "..", "frontend");
  if (!fs.existsSync(frontendDir)) return "frontend directory not found";
  try {
    execSync("npx tsc -b", { encoding: "utf-8", timeout: 120000, cwd: frontendDir, stdio: "pipe" });
    return "check passed: no TypeScript/JSX errors";
  } catch (e: any) {
    const out = `${e.stdout || ""}${e.stderr || ""}`.trim();
    return `check failed — fix these errors, then run check_frontend again:\n${out.slice(0, 2000)}`;
  }
}
