import { AgentContext } from "../src/agent/context";

test("AgentContext adds user messages", () => {
  const context = new AgentContext();
  context.addUserMessage("test message");
  const messages = context.getMessages();
  
  expect(messages.length).toBe(1);
  expect(messages[0].role).toBe("user");
  expect(messages[0].content).toBe("test message");
});

test("AgentContext adds assistant messages", () => {
  const context = new AgentContext();
  context.addAssistantMessage("response");
  const messages = context.getMessages();
  
  expect(messages.length).toBe(1);
  expect(messages[0].role).toBe("assistant");
  expect(messages[0].content).toBe("response");
});

test("AgentContext adds tool results", () => {
  const context = new AgentContext();
  context.addToolResult("glances", { cpu: 50 });
  const messages = context.getMessages();
  
  expect(messages.length).toBe(1);
  expect(messages[0].role).toBe("assistant");
  expect(messages[0].content).toContain("glances");
  expect(messages[0].content).toContain("cpu");
});

test("AgentContext maintains conversation order", () => {
  const context = new AgentContext();
  context.addUserMessage("hello");
  context.addAssistantMessage("hi");
  context.addUserMessage("how are you?");
  const messages = context.getMessages();
  
  expect(messages.length).toBe(3);
  expect(messages[0].role).toBe("user");
  expect(messages[1].role).toBe("assistant");
  expect(messages[2].role).toBe("user");
});

test("AgentContext can be cleared", () => {
  const context = new AgentContext();
  context.addUserMessage("test");
  context.clear();
  expect(context.getMessages().length).toBe(0);
});

