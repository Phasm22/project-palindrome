import axios from "axios";
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import https from "https";
import { pceLogger as logger } from "../../pce/utils/logger";
import { getPrimaryProxmoxConfig } from "./config";

export interface ProxmoxApiConfig {
  url: string;
  tokenId: string;
  tokenSecret: string;
  verifySsl?: boolean;
}

export interface ProxmoxRequestMetadata {
  endpoint: string;
  method: string;
  timestamp: number;
  provenanceId?: string;
}

export interface ProxmoxResponseMetadata {
  status: number;
  timestamp: number;
  durationMs: number;
  provenanceId?: string;
}

/**
 * Proxmox REST API Client
 * 
 * Provides token-based authentication and provenance tracking for all API requests.
 * All requests and responses are wrapped in provenance metadata following the
 * tool://proxmox/... format.
 */
export class ProxmoxClient {
  private apiClient: AxiosInstance | null = null;
  private config: ProxmoxApiConfig;

  constructor(config: ProxmoxApiConfig) {
    this.config = {
      verifySsl: true,
      ...config,
    };

    if (!this.config.url || !this.config.tokenId || !this.config.tokenSecret) {
      throw new Error(
        "PROXMOX_URL, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET must be set"
      );
    }
  }

  /**
   * Get or create authenticated axios instance
   */
  private getApiClient(): AxiosInstance {
    if (this.apiClient) {
      return this.apiClient;
    }

    // Normalize URL (ensure it ends with /api2/json)
    const baseURL = this.config.url.endsWith("/api2/json")
      ? this.config.url
      : `${this.config.url.replace(/\/$/, "")}/api2/json`;

    // Create HTTPS agent with SSL verification option
    const httpsAgent = new https.Agent({
      rejectUnauthorized: this.config.verifySsl !== false,
    });

    // Proxmox API token authentication format: PVEAPIToken=user@realm!tokenid=secret
    // Note: tokenId should already be in format "user@realm!tokenid"
    // So the final format is: PVEAPIToken=user@realm!tokenid=secret
    const authHeader = `PVEAPIToken=${this.config.tokenId}=${this.config.tokenSecret}`;
    
    // Debug: Log which secret is being used (first 4 chars only for security)
    logger.debug("Proxmox API authentication", {
      tokenId: this.config.tokenId,
      secretPrefix: this.config.tokenSecret.substring(0, 4) + "...",
      headerFormat: "PVEAPIToken=<tokenId>=<secret>",
    });

    this.apiClient = axios.create({
      baseURL,
      httpsAgent,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      timeout: 30000, // 30 second timeout
    });

    // Add request interceptor for logging
    this.apiClient.interceptors.request.use(
      (config) => {
        logger.debug("Proxmox API request", {
          method: config.method?.toUpperCase(),
          url: config.url,
          baseURL: config.baseURL,
        });
        return config;
      },
      (error) => {
        logger.error("Proxmox API request error", { error: error.message });
        return Promise.reject(error);
      }
    );

    // Add response interceptor for logging
    this.apiClient.interceptors.response.use(
      (response) => {
        logger.debug("Proxmox API response", {
          status: response.status,
          url: response.config.url,
        });
        return response;
      },
      (error) => {
        logger.error("Proxmox API response error", {
          status: error.response?.status,
          message: error.message,
          url: error.config?.url,
        });
        return Promise.reject(error);
      }
    );

    return this.apiClient;
  }

  /**
   * Generate provenance ID for a request
   */
  private generateProvenanceId(endpoint: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 7);
    const endpointHash = endpoint.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
    return `tool://proxmox/${endpointHash}/${timestamp}-${random}`;
  }

  /**
   * Make a GET request with provenance tracking
   */
  async get<T = any>(
    endpoint: string,
    params?: Record<string, any>
  ): Promise<{ data: T; metadata: ProxmoxResponseMetadata }> {
    const provenanceId = this.generateProvenanceId(endpoint);
    const requestMetadata: ProxmoxRequestMetadata = {
      endpoint,
      method: "GET",
      timestamp: Date.now(),
      provenanceId,
    };

    const startTime = Date.now();
    const client = this.getApiClient();

    try {
      const response: AxiosResponse<T> = await client.get(endpoint, {
        params,
      });

      const durationMs = Date.now() - startTime;
      const responseMetadata: ProxmoxResponseMetadata = {
        status: response.status,
        timestamp: Date.now(),
        durationMs,
        provenanceId,
      };

      logger.debug("Proxmox API request completed", {
        ...requestMetadata,
        ...responseMetadata,
      });

      return {
        data: response.data,
        metadata: responseMetadata,
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      logger.error("Proxmox API request failed", {
        ...requestMetadata,
        durationMs,
        error: error.message,
        status: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Make a POST request with provenance tracking
   */
  async post<T = any>(
    endpoint: string,
    data?: any,
    params?: Record<string, any>
  ): Promise<{ data: T; metadata: ProxmoxResponseMetadata }> {
    const provenanceId = this.generateProvenanceId(endpoint);
    const requestMetadata: ProxmoxRequestMetadata = {
      endpoint,
      method: "POST",
      timestamp: Date.now(),
      provenanceId,
    };

    const startTime = Date.now();
    const client = this.getApiClient();

    try {
      const response: AxiosResponse<T> = await client.post(endpoint, data, {
        params,
      });

      const durationMs = Date.now() - startTime;
      const responseMetadata: ProxmoxResponseMetadata = {
        status: response.status,
        timestamp: Date.now(),
        durationMs,
        provenanceId,
      };

      logger.debug("Proxmox API request completed", {
        ...requestMetadata,
        ...responseMetadata,
      });

      return {
        data: response.data,
        metadata: responseMetadata,
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      logger.error("Proxmox API request failed", {
        ...requestMetadata,
        durationMs,
        error: error.message,
        status: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Make a PUT request with provenance tracking
   */
  async put<T = any>(
    endpoint: string,
    data?: any,
    params?: Record<string, any>
  ): Promise<{ data: T; metadata: ProxmoxResponseMetadata }> {
    const provenanceId = this.generateProvenanceId(endpoint);
    const requestMetadata: ProxmoxRequestMetadata = {
      endpoint,
      method: "PUT",
      timestamp: Date.now(),
      provenanceId,
    };

    const startTime = Date.now();
    const client = this.getApiClient();

    try {
      const response: AxiosResponse<T> = await client.put(endpoint, data, {
        params,
      });

      const durationMs = Date.now() - startTime;
      const responseMetadata: ProxmoxResponseMetadata = {
        status: response.status,
        timestamp: Date.now(),
        durationMs,
        provenanceId,
      };

      logger.debug("Proxmox API request completed", {
        ...requestMetadata,
        ...responseMetadata,
      });

      return {
        data: response.data,
        metadata: responseMetadata,
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      logger.error("Proxmox API request failed", {
        ...requestMetadata,
        durationMs,
        error: error.message,
        status: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Make a DELETE request with provenance tracking
   */
  async delete<T = any>(
    endpoint: string,
    params?: Record<string, any>
  ): Promise<{ data: T; metadata: ProxmoxResponseMetadata }> {
    const provenanceId = this.generateProvenanceId(endpoint);
    const requestMetadata: ProxmoxRequestMetadata = {
      endpoint,
      method: "DELETE",
      timestamp: Date.now(),
      provenanceId,
    };

    const startTime = Date.now();
    const client = this.getApiClient();

    try {
      const response: AxiosResponse<T> = await client.delete(endpoint, {
        params,
      });

      const durationMs = Date.now() - startTime;
      const responseMetadata: ProxmoxResponseMetadata = {
        status: response.status,
        timestamp: Date.now(),
        durationMs,
        provenanceId,
      };

      logger.debug("Proxmox API request completed", {
        ...requestMetadata,
        ...responseMetadata,
      });

      return {
        data: response.data,
        metadata: responseMetadata,
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      logger.error("Proxmox API request failed", {
        ...requestMetadata,
        durationMs,
        error: error.message,
        status: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Get API configuration from environment variables
   */
  static fromEnvironment(): ProxmoxClient {
    const resolved = getPrimaryProxmoxConfig();
    if (!resolved) {
      throw new Error("PROXMOX_URL and a complete Proxmox token ID/secret pair must be set");
    }

    return new ProxmoxClient({
      url: resolved.url,
      tokenId: resolved.tokenId,
      tokenSecret: resolved.tokenSecret,
      verifySsl: resolved.verifySsl,
    });
  }
}
