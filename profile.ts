import fs from "fs";
import { PROFILE_PATH } from "./config";

export interface Profile {
  name: string;
  email: string;
  job?: string;
}

let cached: Profile | null = null;

export function loadProfile(): Profile {
  if (!cached) {
    cached = JSON.parse(fs.readFileSync(PROFILE_PATH, "utf-8"));
  }
  return cached as Profile;
}

export function profilePromptBlock(): string {
  const p = loadProfile();
  return `Your user's profile (use these details automatically for any tool that needs them, e.g. event registration — never ask the user to repeat them):
name: ${p.name}
email: ${p.email}
job: ${p.job ?? "unspecified"}`;
}
