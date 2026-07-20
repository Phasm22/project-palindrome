import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import OpenAI from "openai";
import type { ApplicationAsset } from "./application-manifest";

type ImageGenerationResponse = {
  data?: Array<{ b64_json?: string | null }>;
};

export interface ImageGenerationClient {
  images: {
    generate(request: Record<string, unknown>): Promise<ImageGenerationResponse>;
  };
}

export interface ApplicationAssetArtifact {
  assetId: string;
  path: string;
  destination: string;
  width: number;
  height: number;
  format: ApplicationAsset["format"];
  sha256: string;
  prompt?: string;
  model?: string;
}

export interface GenerateApplicationAssetOptions {
  requestId: string;
  application: string;
  vm: string;
  outputDirectory?: string;
  client?: ImageGenerationClient;
  model?: string;
}

function extensionFor(format: ApplicationAsset["format"]): string {
  return format === "jpeg" ? "jpg" : format;
}

async function artifactFromBytes(
  asset: ApplicationAsset,
  bytes: Uint8Array,
  path: string,
  metadata: Pick<ApplicationAssetArtifact, "prompt" | "model"> = {}
): Promise<ApplicationAssetArtifact> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { mode: 0o600 });
  return {
    assetId: asset.id,
    path,
    destination: asset.destination,
    width: asset.width,
    height: asset.height,
    format: asset.format,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...metadata,
  };
}

export async function generateApplicationAsset(
  asset: ApplicationAsset,
  options: GenerateApplicationAssetOptions
): Promise<ApplicationAssetArtifact> {
  const outputDirectory =
    options.outputDirectory ??
    join(process.cwd(), ".pce", "application-assets");
  const outputPath = join(
    outputDirectory,
    options.requestId,
    options.application,
    options.vm,
    `${asset.id}.${extensionFor(asset.format)}`
  );

  if (asset.source === "path") {
    if (!asset.path) {
      throw new Error(`Asset "${asset.id}" is missing its source path`);
    }
    const bytes = await readFile(asset.path);
    return artifactFromBytes(asset, bytes, outputPath);
  }

  if (!asset.prompt) {
    throw new Error(`Asset "${asset.id}" is missing its generation prompt`);
  }

  const client =
    options.client ??
    (new OpenAI() as unknown as ImageGenerationClient);
  const model = options.model ?? process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";
  const response = await client.images.generate({
    model,
    prompt: asset.prompt,
    size: `${asset.width}x${asset.height}`,
    quality: "high",
    output_format: asset.format,
    n: 1,
  });
  const encoded = response.data?.[0]?.b64_json;
  if (!encoded) {
    throw new Error(`Image generation returned no bytes for asset "${asset.id}"`);
  }

  return artifactFromBytes(
    asset,
    Buffer.from(encoded, "base64"),
    outputPath,
    { prompt: asset.prompt, model }
  );
}
