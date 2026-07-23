import { describe, expect, test } from "bun:test";
import {
  renderAdaptiveValue,
  renderRawTextFallback,
} from "../../dashboard/js/response-renderer.js";

// Synthetic fixtures shaped exactly like src/tools/pihole/client.ts's real
// return types (DnsRecord[], PiholeSummary, TopDomainsResult, etc.), plus the
// "took" timing field the live Pi-hole v6 API actually includes on stats
// endpoints (confirmed against a real running instance). Dials in both
// rendering paths pihole_readonly output travels through:
//   1. dataPreview JSON -> renderAdaptiveValue (Reasoning Traces tool-result cards)
//   2. the LLM's TERSE_DATA pipe-text summary of that same data -> renderRawTextFallback
// stripPreBlocks lets assertions ignore intentional <pre> (code/ASCII table) content.
function stripPreBlocks(html: string): string {
  return html.replace(/<pre[\s\S]*?<\/pre>/g, "");
}

describe("pihole_readonly JSON result shapes (renderAdaptiveValue)", () => {
  test("dns_records_list: bare array of {domain, ip}", () => {
    const html = renderAdaptiveValue([
      { domain: "router.lan", ip: "192.168.1.1" },
      { domain: "nas.lan", ip: "192.168.1.10" },
    ]);
    expect(html).toContain("response-table");
    expect(html).toContain("router.lan");
    expect(html).toContain("192.168.1.1");
    expect(html).not.toContain("response-ascii-table");
  });

  test("dns_top_domains: {domains:[{domain,count}], total_queries, blocked_queries, took}", () => {
    const html = renderAdaptiveValue({
      domains: [
        { domain: "168.192.in-addr.arpa", count: 5307 },
        { domain: "proxbig.prox", count: 805 },
      ],
      total_queries: 24626,
      blocked_queries: 2141,
      took: 0.0016927719116210938,
    });
    expect(html).toContain("response-facts");
    expect(html).toContain("response-table");
    expect(html).toContain("168.192.in-addr.arpa");
    expect(html).toContain("5307");
    expect(html).toContain("24626");
    expect(html).not.toContain("response-ascii-table");
  });

  test("dns_top_blocked_domains: same TopDomainsResult shape as dns_top_domains", () => {
    const html = renderAdaptiveValue({
      domains: [{ domain: "doubleclick.net", count: 412 }],
      total_queries: 24626,
      blocked_queries: 2141,
    });
    expect(html).toContain("doubleclick.net");
    expect(html).toContain("412");
  });

  test("dns_top_clients: {clients:[{name,ip,count}], total_queries, blocked_queries}", () => {
    const html = renderAdaptiveValue({
      clients: [
        { name: "yang.lan", ip: "192.168.1.20", count: 8213 },
        { name: "", ip: "192.168.1.45", count: 301 },
      ],
      total_queries: 24626,
      blocked_queries: 2141,
    });
    expect(html).toContain("response-table");
    expect(html).toContain("yang.lan");
    expect(html).toContain("8213");
    expect(html).toContain("192.168.1.45");
  });

  test("dns_query_types: {types: Record<string, number>}", () => {
    const html = renderAdaptiveValue({
      types: { A: 18234, AAAA: 4021, HTTPS: 1500, PTR: 871 },
    });
    expect(html).toContain("response-facts");
    expect(html).toContain("18234");
    expect(html).toContain("HTTPS");
  });

  test("dns_query_log_search: {queries:[QueryLogEntry]} with nested reply/client objects", () => {
    const html = renderAdaptiveValue({
      queries: [
        {
          id: 1001,
          time: 1753179999,
          type: "A",
          status: "GRAVITY",
          dnssec: "UNKNOWN",
          domain: "doubleclick.net",
          upstream: null,
          reply: { type: "NODATA", time: 0 },
          client: { ip: "192.168.1.20", name: "yang.lan" },
          cname: null,
        },
        {
          id: 1002,
          time: 1753180010,
          type: "AAAA",
          status: "FORWARDED",
          dnssec: "SECURE",
          domain: "github.com",
          upstream: "1.1.1.1#53",
          reply: { type: "IP", time: 12.4 },
          client: { ip: "192.168.1.45", name: null },
          cname: null,
        },
      ],
    });
    expect(html).toContain("response-table");
    expect(html).toContain("doubleclick.net");
    expect(html).toContain("GRAVITY");
    expect(html).toContain("yang.lan");
    expect(html).toContain("None"); // null upstream/name/cname render as None, not the literal word
    expect(html).not.toContain(">null<");
  });

  test("dns_blocking_status: {blocking, timer, took}", () => {
    const enabledHtml = renderAdaptiveValue({ blocking: "enabled", timer: null, took: 0.0015642642974853516 });
    expect(enabledHtml).toContain("response-facts");
    expect(enabledHtml).toContain("enabled");
    expect(enabledHtml).toContain("None"); // null timer

    const disabledHtml = renderAdaptiveValue({ blocking: "disabled", timer: 300 });
    expect(disabledHtml).toContain("disabled");
    expect(disabledHtml).toContain("300");
  });

  test("dns_summary_stats: full PiholeSummary with nested queries/clients/gravity objects", () => {
    const html = renderAdaptiveValue({
      queries: {
        total: 24626,
        blocked: 2141,
        percent_blocked: 8.7,
        unique_domains: 512,
        forwarded: 18000,
        cached: 4485,
        types: { A: 18234, AAAA: 4021 },
        status: { GRAVITY: 2000, FORWARDED: 18000 },
      },
      clients: { active: 12, total: 15 },
      gravity: { domains_being_blocked: 158342, last_update: 1753100000 },
    });
    expect(html).toContain("response-facts");
    expect(html).toContain("24626");
    expect(html).toContain("158342");
    // nested records (queries.types, queries.status, clients, gravity) must
    // not collapse into "[object Object]" or get dropped
    expect(html).not.toContain("[object Object]");
    expect(html).toContain("GRAVITY");
    expect(html).toContain("12");
  });

  test("no pihole result shape ever falls back to the ASCII table renderer", () => {
    const shapes = [
      [{ domain: "a.lan", ip: "1.2.3.4" }],
      { domains: [{ domain: "a.lan", count: 1 }], total_queries: 1, blocked_queries: 0 },
      { clients: [{ name: "a", ip: "1.2.3.4", count: 1 }], total_queries: 1, blocked_queries: 0 },
      { types: { A: 1 } },
      { queries: [{ id: 1, time: 1, type: "A", status: "FORWARDED", dnssec: "UNKNOWN", domain: "a.lan", upstream: null, reply: { type: "IP", time: 1 }, client: { ip: "1.2.3.4", name: null }, cname: null }] },
      { blocking: "enabled", timer: null },
      { queries: { total: 1, blocked: 0, percent_blocked: 0, unique_domains: 1, forwarded: 1, cached: 0, types: {}, status: {} }, clients: { active: 1, total: 1 }, gravity: { domains_being_blocked: 1, last_update: 1 } },
    ];
    for (const shape of shapes) {
      expect(renderAdaptiveValue(shape)).not.toContain("response-ascii-table");
    }
  });
});

describe("pihole DNS TERSE_DATA text (renderRawTextFallback) — ASCII table stays a last resort", () => {
  // Captured verbatim from a live agent run (query: "what are the top 5 DNS
  // domains queried today, and is DNS blocking currently enabled?"). Two
  // unrelated TERSE_DATA pipe rows land back to back — a packed
  // "top_domains | domain=count | ..." row (6 fields) followed by an
  // unrelated "dns_blocking_enabled | status=enabled" row (1 field). Before
  // the entity-row-before-arity-check fix, differing field counts sent this
  // straight to the ASCII table fallback.
  test("a packed top-domains row next to an unrelated blocking-status row does not fall back to ASCII", () => {
    const response =
      "top_domains | domain=count | 168.192.in-addr.arpa=5307 | lb._dns-sd._udp.0.68.168.192.in-addr.arpa=1175 | proxbig.prox=805 | yin.prox=766 | gateway.fe2.apple-dns.net=477\n" +
      "dns_blocking_enabled | status=enabled";

    const html = renderRawTextFallback(response);
    expect(html).not.toContain("response-ascii-table");
    expect(html).toContain("response-fact-groups");
    expect(html).toContain("top_domains");
    expect(html).toContain("168.192.in-addr.arpa");
    expect(html).toContain("5307");
    expect(html).toContain("dns_blocking_enabled");
    expect(html).toContain("enabled");
    expect(stripPreBlocks(html)).not.toContain(" | ");
  });

  // Captured verbatim from a second live run of the same query — the LLM
  // chose a *different* packing this time: one row per topic, but with
  // "domain"/"count" repeated as the key for every domain instead of one
  // row per domain. A naive { [key]: value } union table would silently
  // overwrite every earlier domain/count pair with the last one.
  test("a row with a repeated key (domain=..|count=..|domain=..|count=..) does not drop earlier values", () => {
    const response =
      "top_dns_domains | domain=168.192.in-addr.arpa | count=5207 | domain=lb._dns-sd._udp.0.68.168.192.in-addr.arpa | count=1159 | domain=proxbig.prox | count=801 | domain=yin.prox | count=767 | domain=gateway.fe2.apple-dns.net | count=477\n" +
      "dns_blocking_status | blocking=enabled";

    const html = renderRawTextFallback(response);
    expect(html).not.toContain("response-ascii-table");
    // every domain/count pair must survive, not just the last one
    expect(html).toContain("168.192.in-addr.arpa");
    expect(html).toContain("5207");
    expect(html).toContain("lb._dns-sd._udp.0.68.168.192.in-addr.arpa");
    expect(html).toContain("1159");
    expect(html).toContain("proxbig.prox");
    expect(html).toContain("801");
    expect(html).toContain("yin.prox");
    expect(html).toContain("767");
    expect(html).toContain("gateway.fe2.apple-dns.net");
    expect(html).toContain("477");
    expect(html).toContain("enabled");
  });

  // Synthetic worst case: two rows that WOULD share a schema (both use
  // "domain"/"count" repeatedly) — hasSharedSchema alone would route this
  // into the union-table builder, which is exactly where the { [key]: value }
  // overwrite bug would silently drop data. The duplicate-key guard must
  // override hasSharedSchema and force the data-preserving fact-groups path.
  test("two rows that would share a schema, but each has internally-repeated keys, still preserve every value", () => {
    const response =
      "top_domains | domain=a.com | count=10 | domain=b.com | count=20\n" +
      "top_blocked_domains | domain=c.com | count=5 | domain=d.com | count=15";

    const html = renderRawTextFallback(response);
    expect(html).toContain("a.com");
    expect(html).toContain("10");
    expect(html).toContain("b.com");
    expect(html).toContain("20");
    expect(html).toContain("c.com");
    expect(html).toContain("5");
    expect(html).toContain("d.com");
    expect(html).toContain("15");
  });

  test("well-formed one-row-per-domain TERSE_DATA (the documented convention) renders as a real Entity/count table", () => {
    const response =
      "168.192.in-addr.arpa | count=5307\n" +
      "lb._dns-sd._udp.0.68.168.192.in-addr.arpa | count=1175\n" +
      "proxbig.prox | count=805\n" +
      "yin.prox | count=766\n" +
      "gateway.fe2.apple-dns.net | count=477";

    const html = renderRawTextFallback(response);
    expect(html).toContain("<th>Entity</th>");
    expect(html).toContain("<th>count</th>");
    expect(html).toContain(">168.192.in-addr.arpa<");
    expect(html).toContain(">5307<");
    expect(html).not.toContain("response-ascii-table");
    expect(stripPreBlocks(html)).not.toContain(" | ");
  });

  test("well-formed one-row-per-client top-clients TERSE_DATA renders as a table", () => {
    const response =
      "yang.lan | count=8213\n" +
      "192.168.1.45 | count=301";

    const html = renderRawTextFallback(response);
    expect(html).toContain("<th>Entity</th>");
    expect(html).toContain(">yang.lan<");
    expect(html).toContain(">8213<");
    expect(html).not.toContain("response-ascii-table");
  });

  test("DNS records rendered as one entity row per record, sharing an 'ip' key, table not ASCII", () => {
    const response =
      "router.lan | ip=192.168.1.1\n" +
      "nas.lan | ip=192.168.1.10\n" +
      "printer.lan | ip=192.168.1.30";

    const html = renderRawTextFallback(response);
    expect(html).toContain("<th>Entity</th>");
    expect(html).toContain("<th>ip</th>");
    expect(html).toContain(">router.lan<");
    expect(html).toContain(">192.168.1.10<");
    expect(html).not.toContain("response-ascii-table");
  });

  test("blocking status alone as a single entity row still renders as facts", () => {
    const html = renderRawTextFallback("dns_blocking_enabled | status=enabled | timer=none");
    expect(html).toContain("<th>Entity</th>");
    expect(html).toContain(">enabled<");
    expect(html).not.toContain("response-ascii-table");
  });

  test("three unrelated single-field facts blobs (summary/blocking/gravity) each get their own panel, not one sparse table", () => {
    const response =
      "dns_summary | total=24626\n" +
      "dns_blocking_enabled | status=enabled\n" +
      "gravity | domains_blocked=158342";

    const html = renderRawTextFallback(response);
    expect(html).toContain("response-fact-groups");
    expect(html).not.toContain("response-ascii-table");
    expect(html).not.toContain("<table"); // heterogeneous -> per-entity panels, not one wide table
    expect(html).toContain("dns_summary");
    expect(html).toContain("24626");
    expect(html).toContain("gravity");
    expect(html).toContain("158342");
  });

  test("query-type breakdown as a single facts line (all cells key=value, no bare entity label)", () => {
    const html = renderRawTextFallback("A=18234 | AAAA=4021 | HTTPS=1500 | PTR=871");
    expect(html).toContain("response-facts");
    expect(html).toContain("<dt>A</dt>");
    expect(html).toContain("<dd>18234</dd>");
    expect(html).not.toContain("response-ascii-table");
  });

  test("ASCII table remains the fallback when rows genuinely have no key=value structure to recover", () => {
    // Same shape as the pre-existing "inconsistent column counts" regression
    // test — confirms ASCII is still available as a true last resort, not
    // removed outright, just demoted below entity/table rendering.
    const html = renderRawTextFallback(
      "dns_top_domains | fast growing | needs review\n" +
      "dns_blocking_status | stable\n" +
      "dns_query_log | very large | needs pagination | flagged"
    );
    expect(html).toContain("response-ascii-table");
    expect(html).toContain("dns_top_domains");
  });
});
