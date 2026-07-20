import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  generateApplicationAsset,
  type ImageGenerationClient,
} from "../../src/actions/applications/asset-generator";
import { makeApplicationManifest } from "./fixtures/application-manifest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("generateApplicationAsset", () => {
  test("generates the exact requested size and records provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "palindrome-assets-"));
    temporaryDirectories.push(directory);
    const requests: Record<string, unknown>[] = [];
    const client: ImageGenerationClient = {
      images: {
        async generate(request) {
          requests.push(request);
          return {
            data: [
              {
                b64_json: Buffer.from("fake-image-bytes").toString("base64"),
              },
            ],
          };
        },
      },
    };
    const asset = makeApplicationManifest().applications[0]!.vms[0]!.assets[0]!;

    const artifact = await generateApplicationAsset(asset, {
      requestId: "request-001",
      application: "stark",
      vm: "stark",
      outputDirectory: directory,
      client,
      model: "test-image-model",
    });

    expect(requests[0]?.size).toBe("3840x2160");
    expect(requests[0]?.output_format).toBe("jpeg");
    expect(artifact.model).toBe("test-image-model");
    expect(artifact.prompt).toBe(asset.prompt);
    expect(await readFile(artifact.path, "utf-8")).toBe("fake-image-bytes");
  });

  test("copies path assets into the managed artifact directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "palindrome-assets-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source.png");
    await writeFile(source, "existing-image");
    const asset = makeApplicationManifest().applications[0]!.vms[0]!.assets[0]!;
    asset.source = "path";
    asset.prompt = null;
    asset.path = source;
    asset.format = "png";

    const artifact = await generateApplicationAsset(asset, {
      requestId: "request-002",
      application: "stark",
      vm: "stark",
      outputDirectory: join(directory, "managed"),
    });

    expect(await readFile(artifact.path, "utf-8")).toBe("existing-image");
    expect(artifact.model).toBeUndefined();
  });
});
