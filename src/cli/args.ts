export type CliArgs = {
  code?: string;
  writeEnv: boolean;
  module?: string;
  id?: string;
  email?: string;
  out?: string;
  json: boolean;
  fetchEmailBodies?: number;
  maxRelatedRecords?: number;
  file?: string;
  matchCrm?: string;
  thresholds?: string;
  help: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    writeEnv: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    const next = argv[index + 1];

    switch (token) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--code":
        args.code = next;
        index += 1;
        break;
      case "--write-env":
        args.writeEnv = true;
        break;
      case "--module":
        args.module = next;
        index += 1;
        break;
      case "--id":
        args.id = next;
        index += 1;
        break;
      case "--email":
        args.email = next;
        index += 1;
        break;
      case "--out":
        args.out = next;
        index += 1;
        break;
      case "--json":
        args.json = true;
        break;
      case "--fetch-email-bodies":
        args.fetchEmailBodies = Number(next);
        index += 1;
        break;
      case "--max-related-records":
        args.maxRelatedRecords = Number(next);
        index += 1;
        break;
      case "--file":
        args.file = next;
        index += 1;
        break;
      case "--match-crm":
        args.matchCrm = next;
        index += 1;
        break;
      case "--thresholds":
        args.thresholds = next;
        index += 1;
        break;
      default:
        if (token.startsWith("--")) {
          throw new Error(`Unknown argument: ${token}`);
        }
    }
  }

  return args;
}

export function printDiscoveryHelp(): string {
  return `Zoho Discovery Connector (read-only)

Usage:
  npm run zoho:discover -- --module Contacts --id 1234567890000000001
  npm run zoho:discover -- --email jane@example.com
  npm run zoho:discover -- --module Leads --email jane@example.com --json

Options:
  --module                 Contacts | Leads | Accounts
  --id                     Zoho record ID
  --email                  Search by email if --id is not provided
  --out                    Write diagnostic JSON to this path
  --json                   Print full diagnostic JSON to stdout
  --fetch-email-bodies     How many email bodies to fetch via View Email API (default 2)
  --max-related-records    Records per related list (default 50)
`;
}

export function printAuthHelp(): string {
  return `Exchange a Zoho grant token for a refresh token (read-only scopes).

Usage:
  npm run zoho:auth -- --code 1000.xxxx
  npm run zoho:auth -- --code 1000.xxxx --write-env

Create the Self Client and grant token at https://api-console.zoho.com/
`;
}

export function printUsageImportHelp(): string {
  return `Import Portal Genie usage from CSV or XLSX (no live product database).

Usage:
  npm run usage:import -- --file data/usage-template.csv
  npm run usage:import -- --file data/usage.xlsx --match-crm diagnostics/crm-identities.json

Options:
  --file         Path to .csv or .xlsx
  --match-crm    Optional JSON array of CRM identities for deterministic matching
  --thresholds   Optional activation threshold JSON (default config/activation-thresholds.json)
  --out          Write combined intelligence JSON
  --json         Print full JSON to stdout
`;
}
