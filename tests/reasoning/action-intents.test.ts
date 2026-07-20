import { expect, test } from "bun:test";
import { detectActionIntent } from "../../src/reasoning/action-intents";

test("destroy intent ignores an article before the VM type", () => {
  expect(detectActionIntent("destroy the vm stark")).toEqual({
    type: "destroy_vm",
    name: "stark",
    node: undefined,
  });
});

test("destroy intent extracts a node after the VM name", () => {
  expect(detectActionIntent("destroy the virtual machine stark on proxbig")).toEqual({
    type: "destroy_vm",
    name: "stark",
    node: "proxbig",
  });
});
