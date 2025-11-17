/**
 * Phase I-C: Hybrid Test Fixture Generator
 * Task 11.4: Generate synthetic dataset with guaranteed hybrid overlap
 */

import { join } from "path";

const TEST_DIR = "./.pce-ic-dod-test";

export interface HybridTestDocument {
  content: string;
  entities: string[];
  relationships: Array<{ from: string; to: string; type: string }>;
  sourcePath: string;
}

/**
 * Generate 10 test documents with entities and relationships
 * Designed to ensure hybrid overlap between vector and graph retrieval
 */
export function generateHybridTestData(): HybridTestDocument[] {
  return [
    {
      content: `# Network Infrastructure Documentation

## Host Configuration

The primary web server host-web-01 is configured with IP address 192.168.1.10. 
This host runs the http-service on port 80 and https-service on port 443.

The database server host-db-01 uses IP 192.168.1.20 and runs mysql-service on port 3306.

## Service Dependencies

The http-service depends on mysql-service for data storage. All web traffic 
flows through the load balancer service-lb-01 which routes to host-web-01.

## Alerts

Alert critical-db-connection indicates that host-db-01 is experiencing 
connection issues with mysql-service.`,
      entities: ["host-web-01", "host-db-01", "http-service", "https-service", "mysql-service", "service-lb-01", "critical-db-connection"],
      relationships: [
        { from: "host-web-01", to: "http-service", type: "RUNS" },
        { from: "host-web-01", to: "https-service", type: "RUNS" },
        { from: "host-db-01", to: "mysql-service", type: "RUNS" },
        { from: "http-service", to: "mysql-service", type: "DEPENDS_ON" },
        { from: "service-lb-01", to: "host-web-01", type: "ROUTES_TO" },
        { from: "critical-db-connection", to: "host-db-01", type: "AFFECTS" },
      ],
      sourcePath: join(TEST_DIR, "network-infra.md"),
    },
    {
      content: `# Security Monitoring Setup

## Host Monitoring

Security monitoring is configured for host-web-01 and host-db-01. 
The monitoring service service-monitor-01 collects metrics from both hosts.

## Alert Configuration

Alert security-breach-detected monitors host-web-01 for unauthorized access attempts.
Alert database-access-violation tracks mysql-service access patterns on host-db-01.

## Network Security

The firewall service-fw-01 protects the network segment containing host-web-01 
and host-db-01. All traffic must pass through service-fw-01 before reaching 
the application services.`,
      entities: ["host-web-01", "host-db-01", "service-monitor-01", "security-breach-detected", "database-access-violation", "service-fw-01", "mysql-service"],
      relationships: [
        { from: "service-monitor-01", to: "host-web-01", type: "MONITORS" },
        { from: "service-monitor-01", to: "host-db-01", type: "MONITORS" },
        { from: "security-breach-detected", to: "host-web-01", type: "AFFECTS" },
        { from: "database-access-violation", to: "mysql-service", type: "AFFECTS" },
        { from: "service-fw-01", to: "host-web-01", type: "PROTECTS" },
        { from: "service-fw-01", to: "host-db-01", type: "PROTECTS" },
      ],
      sourcePath: join(TEST_DIR, "security-monitoring.md"),
    },
    {
      content: `# Application Deployment Guide

## Application Hosts

The application is deployed on host-app-01 and host-app-02. Both hosts 
run the application-service which connects to the backend api-service.

## Service Architecture

The api-service is hosted on host-api-01 and depends on mysql-service 
running on host-db-01. The application-service makes HTTP requests to 
api-service for data operations.

## Load Balancing

Service load-balancer-01 distributes traffic between host-app-01 and 
host-app-02. The load balancer health checks both application instances.

## Deployment Alerts

Alert deployment-failed indicates issues with application-service deployment 
on host-app-01. Alert api-timeout tracks response times from api-service.`,
      entities: ["host-app-01", "host-app-02", "host-api-01", "host-db-01", "application-service", "api-service", "mysql-service", "service-load-balancer-01", "deployment-failed", "api-timeout"],
      relationships: [
        { from: "host-app-01", to: "application-service", type: "RUNS" },
        { from: "host-app-02", to: "application-service", type: "RUNS" },
        { from: "host-api-01", to: "api-service", type: "RUNS" },
        { from: "application-service", to: "api-service", type: "CONNECTS_TO" },
        { from: "api-service", to: "mysql-service", type: "DEPENDS_ON" },
        { from: "service-load-balancer-01", to: "host-app-01", type: "ROUTES_TO" },
        { from: "service-load-balancer-01", to: "host-app-02", type: "ROUTES_TO" },
        { from: "deployment-failed", to: "host-app-01", type: "AFFECTS" },
        { from: "api-timeout", to: "api-service", type: "AFFECTS" },
      ],
      sourcePath: join(TEST_DIR, "app-deployment.md"),
    },
    {
      content: `# Database Operations Manual

## Database Hosts

The primary database runs on host-db-01 with mysql-service. A replica 
database is configured on host-db-02 also running mysql-service.

## Replication Setup

The mysql-service on host-db-02 replicates data from the mysql-service 
on host-db-01. Replication is managed by the replication-service.

## Backup Configuration

Backup operations are performed by service-backup-01 which connects to 
both host-db-01 and host-db-02. Backups run daily at 2 AM.

## Database Alerts

Alert replication-lag indicates that host-db-02 is falling behind in 
replication from host-db-01. Alert backup-failed tracks backup operation 
failures on service-backup-01.`,
      entities: ["host-db-01", "host-db-02", "mysql-service", "replication-service", "service-backup-01", "replication-lag", "backup-failed"],
      relationships: [
        { from: "host-db-01", to: "mysql-service", type: "RUNS" },
        { from: "host-db-02", to: "mysql-service", type: "RUNS" },
        { from: "host-db-02", to: "host-db-01", type: "REPLICATES_FROM" },
        { from: "replication-service", to: "host-db-01", type: "MANAGES" },
        { from: "replication-service", to: "host-db-02", type: "MANAGES" },
        { from: "service-backup-01", to: "host-db-01", type: "BACKS_UP" },
        { from: "service-backup-01", to: "host-db-02", type: "BACKS_UP" },
        { from: "replication-lag", to: "host-db-02", type: "AFFECTS" },
        { from: "backup-failed", to: "service-backup-01", type: "AFFECTS" },
      ],
      sourcePath: join(TEST_DIR, "database-ops.md"),
    },
    {
      content: `# Network Topology Documentation

## Core Network Infrastructure

The network is divided into three segments: production, staging, and development.

## Production Segment

The production segment includes host-web-01, host-db-01, and host-api-01. 
All production hosts are protected by service-fw-01.

## Staging Segment

The staging environment uses host-staging-01 and host-staging-02. These 
hosts run staging versions of application-service and api-service.

## Development Segment

Development hosts host-dev-01 and host-dev-02 are isolated from production 
and staging networks. They run development versions of services.

## Network Services

Service network-monitor-01 monitors all network segments and generates 
alerts for network issues. Alert network-partition indicates connectivity 
problems between network segments.`,
      entities: ["host-web-01", "host-db-01", "host-api-01", "service-fw-01", "host-staging-01", "host-staging-02", "application-service", "api-service", "host-dev-01", "host-dev-02", "service-network-monitor-01", "network-partition"],
      relationships: [
        { from: "service-fw-01", to: "host-web-01", type: "PROTECTS" },
        { from: "service-fw-01", to: "host-db-01", type: "PROTECTS" },
        { from: "service-fw-01", to: "host-api-01", type: "PROTECTS" },
        { from: "host-staging-01", to: "application-service", type: "RUNS" },
        { from: "host-staging-02", to: "api-service", type: "RUNS" },
        { from: "host-dev-01", to: "application-service", type: "RUNS" },
        { from: "host-dev-02", to: "api-service", type: "RUNS" },
        { from: "service-network-monitor-01", to: "host-web-01", type: "MONITORS" },
        { from: "network-partition", to: "host-web-01", type: "AFFECTS" },
      ],
      sourcePath: join(TEST_DIR, "network-topology.md"),
    },
    {
      content: `# Monitoring and Alerting Guide

## Monitoring Services

Service monitoring-primary monitors all production hosts including 
host-web-01, host-db-01, and host-api-01. Service monitoring-secondary 
provides redundancy for monitoring operations.

## Alert Types

Alert cpu-high indicates high CPU usage on monitored hosts. Alert 
memory-low tracks low memory conditions. Alert disk-full monitors 
disk space usage.

## Host Monitoring

Host-web-01 is monitored for HTTP response times and error rates. 
Host-db-01 is monitored for database query performance and connection 
pool usage. Host-api-01 is monitored for API response times and 
throughput.

## Alert Routing

All alerts are routed through service-alert-router-01 which distributes 
notifications to appropriate teams based on alert severity and affected 
hosts.`,
      entities: ["service-monitoring-primary", "host-web-01", "host-db-01", "host-api-01", "service-monitoring-secondary", "cpu-high", "memory-low", "disk-full", "service-alert-router-01"],
      relationships: [
        { from: "service-monitoring-primary", to: "host-web-01", type: "MONITORS" },
        { from: "service-monitoring-primary", to: "host-db-01", type: "MONITORS" },
        { from: "service-monitoring-primary", to: "host-api-01", type: "MONITORS" },
        { from: "cpu-high", to: "host-web-01", type: "AFFECTS" },
        { from: "memory-low", to: "host-db-01", type: "AFFECTS" },
        { from: "disk-full", to: "host-api-01", type: "AFFECTS" },
        { from: "service-alert-router-01", to: "cpu-high", type: "ROUTES" },
        { from: "service-alert-router-01", to: "memory-low", type: "ROUTES" },
      ],
      sourcePath: join(TEST_DIR, "monitoring-alerts.md"),
    },
    {
      content: `# Service Dependencies Map

## Web Tier Services

The web tier consists of http-service and https-service both running 
on host-web-01. These services handle incoming HTTP and HTTPS requests.

## Application Tier

The application tier includes application-service running on host-app-01 
and host-app-02. These services process business logic and user requests.

## API Tier

The API tier has api-service running on host-api-01. This service 
provides REST API endpoints for application services.

## Database Tier

The database tier consists of mysql-service running on host-db-01 
and host-db-02. These services store and retrieve application data.

## Service Connections

http-service connects to application-service. application-service 
connects to api-service. api-service connects to mysql-service. 
This creates a complete request flow from web to database.`,
      entities: ["http-service", "https-service", "host-web-01", "application-service", "host-app-01", "host-app-02", "api-service", "host-api-01", "mysql-service", "host-db-01", "host-db-02"],
      relationships: [
        { from: "host-web-01", to: "http-service", type: "RUNS" },
        { from: "host-web-01", to: "https-service", type: "RUNS" },
        { from: "host-app-01", to: "application-service", type: "RUNS" },
        { from: "host-app-02", to: "application-service", type: "RUNS" },
        { from: "host-api-01", to: "api-service", type: "RUNS" },
        { from: "host-db-01", to: "mysql-service", type: "RUNS" },
        { from: "host-db-02", to: "mysql-service", type: "RUNS" },
        { from: "http-service", to: "application-service", type: "CONNECTS_TO" },
        { from: "application-service", to: "api-service", type: "CONNECTS_TO" },
        { from: "api-service", to: "mysql-service", type: "CONNECTS_TO" },
      ],
      sourcePath: join(TEST_DIR, "service-dependencies.md"),
    },
    {
      content: `# Incident Response Procedures

## Critical Alerts

When alert critical-db-connection is triggered, it indicates that 
host-db-01 cannot connect to mysql-service. This requires immediate 
investigation.

## Security Incidents

Alert security-breach-detected on host-web-01 triggers security 
incident response procedures. The security team investigates and 
may isolate the affected host.

## Performance Issues

Alert api-timeout affecting api-service indicates performance 
degradation. The operations team checks host-api-01 for resource 
constraints and scaling needs.

## Database Issues

Alert replication-lag on host-db-02 requires checking replication 
service status and network connectivity between host-db-01 and 
host-db-02.

## Backup Failures

When alert backup-failed is triggered for service-backup-01, 
backup operations must be manually verified and restarted if 
necessary.`,
      entities: ["critical-db-connection", "host-db-01", "mysql-service", "security-breach-detected", "host-web-01", "api-timeout", "api-service", "host-api-01", "replication-lag", "host-db-02", "backup-failed", "service-backup-01"],
      relationships: [
        { from: "critical-db-connection", to: "host-db-01", type: "AFFECTS" },
        { from: "critical-db-connection", to: "mysql-service", type: "AFFECTS" },
        { from: "security-breach-detected", to: "host-web-01", type: "AFFECTS" },
        { from: "api-timeout", to: "api-service", type: "AFFECTS" },
        { from: "api-timeout", to: "host-api-01", type: "AFFECTS" },
        { from: "replication-lag", to: "host-db-02", type: "AFFECTS" },
        { from: "backup-failed", to: "service-backup-01", type: "AFFECTS" },
      ],
      sourcePath: join(TEST_DIR, "incident-response.md"),
    },
    {
      content: `# Load Balancing Configuration

## Load Balancer Services

Service load-balancer-01 distributes traffic across multiple application 
hosts. Service-lb-01 handles web traffic routing.

## Backend Hosts

Load balancer-01 routes requests to host-app-01 and host-app-02. 
Service-lb-01 routes to host-web-01.

## Health Checks

Load balancer-01 performs health checks on application-service instances 
running on host-app-01 and host-app-02. Service-lb-01 checks http-service 
on host-web-01.

## Traffic Distribution

Traffic is distributed evenly across backend hosts. If a host fails 
health checks, traffic is automatically routed to remaining healthy hosts.

## Monitoring

Load balancer metrics are monitored by service-monitoring-primary. 
Alert lb-backend-down indicates when all backend hosts fail health checks.`,
      entities: ["service-load-balancer-01", "service-lb-01", "host-app-01", "host-app-02", "host-web-01", "application-service", "http-service", "service-monitoring-primary", "lb-backend-down"],
      relationships: [
        { from: "service-load-balancer-01", to: "host-app-01", type: "ROUTES_TO" },
        { from: "service-load-balancer-01", to: "host-app-02", type: "ROUTES_TO" },
        { from: "service-lb-01", to: "host-web-01", type: "ROUTES_TO" },
        { from: "host-app-01", to: "application-service", type: "RUNS" },
        { from: "host-app-02", to: "application-service", type: "RUNS" },
        { from: "host-web-01", to: "http-service", type: "RUNS" },
        { from: "service-monitoring-primary", to: "service-load-balancer-01", type: "MONITORS" },
        { from: "lb-backend-down", to: "service-load-balancer-01", type: "AFFECTS" },
      ],
      sourcePath: join(TEST_DIR, "load-balancing.md"),
    },
    {
      content: `# Firewall and Security Configuration

## Firewall Services

Service-fw-01 protects the production network segment. All incoming 
traffic must pass through service-fw-01 before reaching application hosts.

## Protected Hosts

Service-fw-01 protects host-web-01, host-db-01, and host-api-01. 
These hosts are in the production network segment.

## Security Rules

Firewall rules allow HTTP and HTTPS traffic to host-web-01. Database 
traffic to host-db-01 is restricted to specific source IPs. API traffic 
to host-api-01 is allowed from application hosts only.

## Security Monitoring

Service monitoring-primary monitors firewall logs and generates alerts 
for suspicious activity. Alert firewall-breach indicates potential 
security violations detected by service-fw-01.

## Network Isolation

The firewall isolates production hosts from staging and development 
networks. Cross-segment traffic is blocked unless explicitly allowed 
by firewall rules.`,
      entities: ["service-fw-01", "host-web-01", "host-db-01", "host-api-01", "service-monitoring-primary", "firewall-breach"],
      relationships: [
        { from: "service-fw-01", to: "host-web-01", type: "PROTECTS" },
        { from: "service-fw-01", to: "host-db-01", type: "PROTECTS" },
        { from: "service-fw-01", to: "host-api-01", type: "PROTECTS" },
        { from: "service-monitoring-primary", to: "service-fw-01", type: "MONITORS" },
        { from: "firewall-breach", to: "service-fw-01", type: "AFFECTS" },
      ],
      sourcePath: join(TEST_DIR, "firewall-security.md"),
    },
  ];
}

