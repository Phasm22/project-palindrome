import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { PiholeReadOnlyTool } from "../../../../src/tools/pihole/readonly";
import * as piholeClientModule from "../../../../src/tools/pihole/client";
import type { ExecutionContext } from "../../../../src/types/execution";

const testContext: ExecutionContext = { toolName: "pihole_readonly", startedAt: Date.now() };

describe("PiholeReadOnlyTool", () => {
  let tool: PiholeReadOnlyTool;

  beforeEach(() => {
    tool = new PiholeReadOnlyTool();
  });

  describe("schema shape", () => {
    test("exposes all 8 read-only DNS actions", () => {
      const schema = tool.getSchema();
      const params = schema.parameters as any;
      const actions: string[] = params.properties?.action?.enum || [];

      expect(actions).toEqual(
        expect.arrayContaining([
          "dns_records_list",
          "dns_summary_stats",
          "dns_top_domains",
          "dns_top_blocked_domains",
          "dns_top_clients",
          "dns_query_types",
          "dns_query_log_search",
          "dns_blocking_status",
        ])
      );
      expect(actions.length).toBe(8);
    });

    test("is marked low-risk and viewer-readable", () => {
      expect(tool.metadata.risk).toBe("low");
      expect(tool.metadata.allowedAcls).toContain("viewer");
    });

    test("notes explicitly steer the agent away from opnsense_readonly/ssh_execute for DNS", () => {
      const schema = tool.getSchema();
      const notesText = (schema.notes || []).join(" ");
      expect(notesText).toContain("opnsense_readonly");
      expect(notesText.toLowerCase()).toContain("dns is served by pi-hole");
    });
  });

  describe("write-action rejection", () => {
    // The action enum only ever contains read-only names, so the write-guard
    // (defense in depth, mirroring OpnsenseReadOnlyBase) is only reachable by
    // calling it directly, same convention as the existing opnsense-readonly
    // test file (`tool as any` to reach the protected base-class methods).
    test("isWriteOperation flags create/delete-shaped action names", () => {
      const baseTool = tool as any;
      expect(baseTool.isWriteOperation("create_dns_record")).toBe(true);
      expect(baseTool.isWriteOperation("delete_dns_record")).toBe(true);
      expect(baseTool.isWriteOperation("dns_records_list")).toBe(false);
      expect(baseTool.isWriteOperation("dns_top_domains")).toBe(false);
    });

    test("validateReadOnly returns an OPERATION_FORBIDDEN error for a write-shaped action", () => {
      const baseTool = tool as any;
      const result = baseTool.validateReadOnly("create_dns_record");
      expect(result?.error).toContain("OPERATION_FORBIDDEN");
      expect(baseTool.validateReadOnly("dns_records_list")).toBeNull();
    });

    test("rejects an invalid action outside the enum", async () => {
      const result = await tool.execute({ action: "not_a_real_action" } as any, testContext);
      expect(result.error).toContain("Invalid parameters");
    });
  });

  describe("action dispatch", () => {
    test("dns_records_list calls PiholeClient.listDnsRecords()", async () => {
      const spy = spyOn(piholeClientModule.PiholeClient.prototype, "listDnsRecords").mockResolvedValue([
        { domain: "homebridge.prox", ip: "172.16.0.100" },
      ]);
      const result = await tool.execute({ action: "dns_records_list" } as any, testContext);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.data).toEqual([{ domain: "homebridge.prox", ip: "172.16.0.100" }]);
      spy.mockRestore();
    });

    test("dns_top_domains calls getTopDomains() with count, no blocked filter", async () => {
      const spy = spyOn(piholeClientModule.PiholeClient.prototype, "getTopDomains").mockResolvedValue({
        domains: [{ domain: "example.com", count: 5 }],
        total_queries: 100,
        blocked_queries: 10,
      });
      await tool.execute({ action: "dns_top_domains", count: 5 } as any, testContext);
      expect(spy).toHaveBeenCalledWith({ blocked: undefined, count: 5 });
      spy.mockRestore();
    });

    test("dns_top_blocked_domains calls getTopDomains() with blocked=true", async () => {
      const spy = spyOn(piholeClientModule.PiholeClient.prototype, "getTopDomains").mockResolvedValue({
        domains: [],
        total_queries: 0,
        blocked_queries: 0,
      });
      await tool.execute({ action: "dns_top_blocked_domains", count: 3 } as any, testContext);
      expect(spy).toHaveBeenCalledWith({ blocked: true, count: 3 });
      spy.mockRestore();
    });

    test("dns_top_clients calls getTopClients()", async () => {
      const spy = spyOn(piholeClientModule.PiholeClient.prototype, "getTopClients").mockResolvedValue({
        clients: [{ name: "", ip: "172.16.0.100", count: 42 }],
        total_queries: 100,
        blocked_queries: 10,
      });
      const result = await tool.execute({ action: "dns_top_clients" } as any, testContext);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((result.data as any).clients[0].ip).toBe("172.16.0.100");
      spy.mockRestore();
    });

    test("dns_query_types calls getQueryTypes()", async () => {
      const spy = spyOn(piholeClientModule.PiholeClient.prototype, "getQueryTypes").mockResolvedValue({
        types: { A: 10, AAAA: 5 },
      });
      await tool.execute({ action: "dns_query_types" } as any, testContext);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    test("dns_query_log_search passes domain/client_ip/type/from/until/length through to searchQueries()", async () => {
      const spy = spyOn(piholeClientModule.PiholeClient.prototype, "searchQueries").mockResolvedValue({
        queries: [],
      });
      await tool.execute(
        {
          action: "dns_query_log_search",
          domain: "example.com",
          client_ip: "172.16.0.100",
          query_type: "AAAA",
          from: 1000,
          until: 2000,
          length: 20,
        } as any,
        testContext
      );
      expect(spy).toHaveBeenCalledWith({
        domain: "example.com",
        clientIp: "172.16.0.100",
        type: "AAAA",
        from: 1000,
        until: 2000,
        length: 20,
      });
      spy.mockRestore();
    });

    test("dns_blocking_status calls getBlockingStatus()", async () => {
      const spy = spyOn(piholeClientModule.PiholeClient.prototype, "getBlockingStatus").mockResolvedValue({
        blocking: "enabled",
        timer: null,
      });
      const result = await tool.execute({ action: "dns_blocking_status" } as any, testContext);
      expect((result.data as any).blocking).toBe("enabled");
      spy.mockRestore();
    });

    test("dns_summary_stats calls getStatistics() (the corrected v6 endpoint)", async () => {
      const spy = spyOn(piholeClientModule.PiholeClient.prototype, "getStatistics").mockResolvedValue({
        queries: { total: 100, blocked: 10 },
      } as any);
      await tool.execute({ action: "dns_summary_stats" } as any, testContext);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    test("wraps a client error as a sanitized ExecutionResult error, not a throw", async () => {
      const spy = spyOn(piholeClientModule.PiholeClient.prototype, "listDnsRecords").mockRejectedValue(
        new Error("Pi-hole login failed: connection refused")
      );
      const result = await tool.execute({ action: "dns_records_list" } as any, testContext);
      expect(result.error).toContain("Pi-hole API error");
      spy.mockRestore();
    });
  });
});
