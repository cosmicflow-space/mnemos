#!/usr/bin/env node
/**
 * @mnemos/cli — entry point
 *
 * Commands (v0.1 target):
 *   mnemos pair add <folder>     Pair a folder (scope: read-only)
 *   mnemos pair list             List paired folders
 *   mnemos pair remove <folder>  Unpair + purge chunks
 *   mnemos ingest [folder]       Ingest paired folder(s)
 *   mnemos auth show             Print the bearer token (chmod-protected)
 *   mnemos auth rotate           Rotate the bearer token
 *   mnemos doctor                Self-diagnose configuration
 *
 * Stub for v0.1 — implementations land in next pass.
 */

const args = process.argv.slice(2);
const cmd = args[0];

const helpText = `mnemos — personal RAG CLI

Usage:
  mnemos pair add <folder>      Pair a folder for ingestion
  mnemos pair list              List paired folders
  mnemos pair remove <folder>   Unpair and purge chunks
  mnemos ingest [folder]        Ingest paired folders
  mnemos auth show              Print the bearer token
  mnemos auth rotate            Rotate the bearer token
  mnemos doctor                 Self-diagnose configuration
  mnemos --help                 Show this help

Status: v0.1 scaffold. Command implementations land in next build pass.
`;

if (!cmd || cmd === "--help" || cmd === "-h") {
  process.stdout.write(helpText);
  process.exit(0);
}

process.stderr.write(`mnemos: command '${cmd}' not yet implemented (v0.1 scaffold)\n`);
process.exit(1);
