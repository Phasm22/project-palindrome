/**
 * Temperature Data Fetcher for Proxmox Nodes
 * Fetches temperature data via SSH using the sensors command
 */

import { SSHTool } from "../../SSHTool";
import { pceLogger } from "../../../pce/utils/logger";

export interface TemperatureReading {
  sensor: string;
  value: number; // Celsius
  unit: "celsius";
  label?: string;
  max?: number;
  crit?: number;
}

export interface NodeTemperatureData {
  node: string;
  temperatures: TemperatureReading[];
  timestamp: string;
  source: "ssh_sensors";
}

/**
 * Map Proxmox node names to SSH host identifiers
 */
function getSSHHostForNode(nodeName: string): string | null {
  const nodeMap: Record<string, string> = {
    proxBig: "172.16.0.10",
    proxbig: "172.16.0.10",
    "prox-big": "172.16.0.10",
    yin: "172.16.0.11",
    YANG: "172.16.0.12",
    yang: "172.16.0.12",
  };

  const normalized = nodeName.toLowerCase().replace(/[_-]/g, "");
  for (const [key, host] of Object.entries(nodeMap)) {
    if (key.toLowerCase().replace(/[_-]/g, "") === normalized) {
      return host;
    }
  }

  // Try direct match
  if (nodeMap[nodeName]) {
    return nodeMap[nodeName];
  }

  return null;
}

/**
 * Parse sensors JSON output
 */
function parseSensorsJson(output: string): TemperatureReading[] {
  try {
    const data = JSON.parse(output);
    const readings: TemperatureReading[] = [];

    // Sensors JSON structure: { "chip": { "adapter": { "sensor": { "temp": value, ... } } } }
    for (const [chipName, chipData] of Object.entries(data)) {
      if (typeof chipData === "object" && chipData !== null) {
        for (const [adapterName, adapterData] of Object.entries(chipData as any)) {
          if (typeof adapterData === "object" && adapterData !== null) {
            for (const [sensorName, sensorData] of Object.entries(adapterData as any)) {
              if (typeof sensorData === "object" && sensorData !== null) {
                const sensor = sensorData as any;
                if (sensor.temp !== undefined || sensor.temp_input !== undefined) {
                  const temp = sensor.temp !== undefined ? sensor.temp : sensor.temp_input;
                  if (typeof temp === "number") {
                    readings.push({
                      sensor: `${chipName}/${adapterName}/${sensorName}`,
                      value: temp,
                      unit: "celsius",
                      label: sensorName,
                      max: sensor.temp_max,
                      crit: sensor.temp_crit,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    return readings;
  } catch (error: any) {
    pceLogger.debug("Failed to parse sensors JSON, will try text format", { 
      error: error?.message || String(error) 
    });
    return [];
  }
}

/**
 * Parse sensors text output
 */
function parseSensorsText(output: string): TemperatureReading[] {
  const readings: TemperatureReading[] = [];
  const lines = output.split("\n");

  let currentChip: string | null = null;
  let currentAdapter: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Chip/adapter header: "chip-name-adapter-0"
    if (trimmed.includes("Adapter:") || (!trimmed.includes(":") && !trimmed.includes("°"))) {
      // This might be a chip name
      if (!trimmed.includes("Adapter:")) {
        currentChip = trimmed;
      }
      continue;
    }

    // Temperature line: "temp1:        +45.0°C  (high = +80.0°C, crit = +100.0°C)"
    const tempMatch = trimmed.match(/^([^:]+):\s*([+-]?\d+\.?\d*)\s*°C/);
    if (tempMatch) {
      const sensorName = tempMatch[1].trim();
      const tempValue = parseFloat(tempMatch[2]);

      // Extract high and crit if present
      const highMatch = trimmed.match(/high\s*=\s*([+-]?\d+\.?\d*)\s*°C/i);
      const critMatch = trimmed.match(/crit\s*=\s*([+-]?\d+\.?\d*)\s*°C/i);

      readings.push({
        sensor: currentChip ? `${currentChip}/${sensorName}` : sensorName,
        value: tempValue,
        unit: "celsius",
        label: sensorName,
        max: highMatch ? parseFloat(highMatch[1]) : undefined,
        crit: critMatch ? parseFloat(critMatch[1]) : undefined,
      });
    }
  }

  return readings;
}

/**
 * Fetch temperature data for a Proxmox node via SSH
 */
export async function fetchNodeTemperature(
  nodeName: string
): Promise<NodeTemperatureData | null> {
  const sshHost = getSSHHostForNode(nodeName);
  if (!sshHost) {
    pceLogger.debug(`No SSH host mapping found for node: ${nodeName}`);
    return null;
  }

  try {
    const sshTool = new SSHTool();
    
    // Try JSON format first (more structured)
    const jsonResult = await sshTool.execute(
      {
        host: sshHost,
        command: "sensors -j",
        category: "system",
      },
      { toolName: "ssh_execute", startedAt: Date.now() }
    );

    let readings: TemperatureReading[] = [];

    if (!jsonResult.error && jsonResult.data?.stdout) {
      readings = parseSensorsJson(jsonResult.data.stdout);
    }

    // If JSON parsing failed or returned no readings, try text format
    if (readings.length === 0) {
      const textResult = await sshTool.execute(
        {
          host: sshHost,
          command: "sensors",
          category: "system",
        },
        { toolName: "ssh_execute", startedAt: Date.now() }
      );

      if (!textResult.error && textResult.data?.stdout) {
        readings = parseSensorsText(textResult.data.stdout);
      }
    }

    if (readings.length === 0) {
      pceLogger.debug(`No temperature readings found for node: ${nodeName}`);
      return null;
    }

    return {
      node: nodeName,
      temperatures: readings,
      timestamp: new Date().toISOString(),
      source: "ssh_sensors",
    };
  } catch (error: any) {
    pceLogger.warn(`Failed to fetch temperature for node ${nodeName}`, {
      error: error.message,
      sshHost,
    });
    return null;
  }
}

/**
 * Get summary temperature (highest CPU/core temperature)
 */
export function getSummaryTemperature(data: NodeTemperatureData): {
  max: number;
  avg: number;
  sensors: number;
} | null {
  if (data.temperatures.length === 0) {
    return null;
  }

  const values = data.temperatures.map((t) => t.value);
  const max = Math.max(...values);
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;

  return {
    max,
    avg: Math.round(avg * 10) / 10,
    sensors: data.temperatures.length,
  };
}
