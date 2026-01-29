import { buildTwinPromptSuggestions } from "../../src/pce/api/prompt-suggestion-service";

test("buildTwinPromptSuggestions uses twin names and temperature", () => {
  const suggestions = buildTwinPromptSuggestions({
    nodes: [
      {
        id: "compute-node:yin",
        name: "yin",
        vmCount: 2,
        status: "online",
        temperature: { max: 62, average: 54, sensors: 3 },
      },
    ],
    vms: [
      {
        id: "compute-vm:yin:101",
        name: "app-server",
        nodeName: "yin",
        state: "running",
        vmKind: "qemu",
      },
    ],
  });

  const prompts = suggestions.map((s) => s.prompt);
  expect(prompts.some((prompt) => prompt.includes("yin"))).toBe(true);
  expect(suggestions.some((s) => s.title === "Node temperatures")).toBe(true);
});

test("buildTwinPromptSuggestions includes node health when offline", () => {
  const suggestions = buildTwinPromptSuggestions({
    nodes: [
      {
        id: "compute-node:yang",
        name: "yang",
        vmCount: 0,
        status: "offline",
      },
    ],
    vms: [],
  });

  expect(suggestions.some((s) => s.title === "Node health")).toBe(true);
});
