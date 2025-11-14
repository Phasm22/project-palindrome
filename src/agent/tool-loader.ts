import { BaseTool } from "../tools/BaseTool";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadTools(): BaseTool[] {
  const toolsDir = path.join(__dirname, "../tools");
  const files = fs.readdirSync(toolsDir);

  const tools: BaseTool[] = [];

  for (const file of files) {
    if (file === "BaseTool.ts") continue;
    // Future tool autoloading will go here
  }

  return tools;
}

