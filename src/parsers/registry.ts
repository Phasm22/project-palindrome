import type { Parser } from "./types";
import type { ParserResult, ParserContext } from "./types";

/**
 * Lightweight in-memory registry so that ingestion code can stay decoupled
 * from specific parser implementations.
 */
export class ParserRegistry {
  private parsers: Map<string, Parser<any>[]> = new Map();

  register<Input>(parser: Parser<Input>): void {
    const existing = this.parsers.get(parser.domain) ?? [];
    this.parsers.set(parser.domain, [...existing, parser]);
  }

  /**
   * Run every parser registered for a domain and flatten the results.
   */
  async runDomain<Input = unknown>(
    domain: string,
    input: Input,
    context: ParserContext
  ): Promise<ParserResult> {
    const domainParsers = this.parsers.get(domain) ?? [];
    const aggregated: ParserResult = {
      entities: [],
      relationships: [],
    };

    for (const parser of domainParsers) {
      const result = await parser.parse(input, context);
      aggregated.entities.push(...result.entities);
      aggregated.relationships.push(...result.relationships);
      if (result.metadata) {
        aggregated.metadata = {
          ...(aggregated.metadata ?? {}),
          ...result.metadata,
        };
      }
    }

    return aggregated;
  }

  clear(): void {
    this.parsers.clear();
  }
}

