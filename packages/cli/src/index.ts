#!/usr/bin/env node
/**
 * @mnemos/cli — entry point
 *
 * Commands (v0.1 target):
 *   mnemos source add <path>     Register a folder or URL as an ingestion source
 *   mnemos source list           List registered sources
 *   mnemos source remove <path>  Unregister + purge chunks
 *   mnemos ingest [path]         Ingest registered source(s)
 *   mnemos auth show             Print the bearer token (chmod-protected)
 *   mnemos auth rotate           Rotate the bearer token
 *   mnemos check                 Self-diagnose configuration
 *
 * Stub for v0.1 — implementations land in next pass.
 */

const args = process.argv.slice(2);
const cmd = args[0];

const helpText = `mnemos — personal RAG CLI

Usage:
  mnemos source add <path>      Register a folder or URL for ingestion
  mnemos source list            List registered sources
  mnemos source remove <path>   Unregister and purge chunks
  mnemos ingest [path]          Ingest registered source(s)
  mnemos auth show              Print the bearer token
  mnemos auth rotate            Rotate the bearer token
  mnemos check                  Self-diagnose configuration
  mnemos --help                 Show this help

Status: v0.1 scaffold. Command implementations land in next build pass.
`;

if (!cmd || cmd === "--help" || cmd === "-h") {
  process.stdout.write(helpText);
  process.exit(0);
}

process.stderr.write(`mnemos: command '${cmd}' not yet implemented (v0.1 scaffold)\n`);
process.exit(1);
