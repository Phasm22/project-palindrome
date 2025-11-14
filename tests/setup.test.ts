import { loadYaml } from "../src/utils/config";

test("config loader works", () => {
  const topology = loadYaml("docs/topology.yaml");
  expect(topology).toBeDefined();
});

