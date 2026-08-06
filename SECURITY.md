# Security policy

## Scope

This repository contains the provider-neutral CVG Workspace Protocol. It does
not contain provider credentials, production workspace data, or deployment
configuration.

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability.
Report it privately to the repository owner through GitHub Security Advisories
or the contact channel configured on the repository profile. Include a clear
description, reproduction steps, affected versions, and a suggested
mitigation when available.

Do not include secrets or personal data in a report.

## Operational boundaries

The package assumes that its workspace root is trusted and controlled by the
host application. Do not place it on an attacker-writable path, and redact
secrets before sending assembled context to a remote model provider.
