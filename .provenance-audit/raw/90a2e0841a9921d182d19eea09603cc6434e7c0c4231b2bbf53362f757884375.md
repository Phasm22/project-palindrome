# Network Infrastructure Documentation

## Host Configuration

The primary web server host-web-01 is configured with IP address 192.168.1.10. 
This host runs the http-service on port 80 and https-service on port 443.

The database server host-db-01 uses IP 192.168.1.20 and runs mysql-service on port 3306.

## Service Dependencies

The http-service depends on mysql-service for data storage. All web traffic 
flows through the load balancer service-lb-01 which routes to host-web-01.

## Alerts

Alert critical-db-connection indicates that host-db-01 is experiencing 
connection issues with mysql-service.