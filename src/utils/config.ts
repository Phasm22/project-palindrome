import fs from "fs";
import YAML from "yaml";

export function loadYaml(path: string) {
  const file = fs.readFileSync(path, "utf-8");
  return YAML.parse(file);
}

