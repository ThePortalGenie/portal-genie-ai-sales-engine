export function detectDelimiter(headerLine: string): "," | ";" {
  const commas = (headerLine.match(/,/g) ?? []).length;
  const semicolons = (headerLine.match(/;/g) ?? []).length;
  return semicolons > commas ? ";" : ",";
}

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const content = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!content.trim()) {
    return { headers: [], rows: [] };
  }
  const firstLine = content.split("\n")[0] ?? "";
  const delimiter = detectDelimiter(firstLine);
  const records = splitCsv(content, delimiter);
  const headers = records[0] ?? [];
  const rows = records.slice(1).filter((row) => row.some((cell) => cell.trim() !== ""));
  return { headers, rows };
}

function splitCsv(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }

  row.push(field);
  if (row.length > 1 || row[0] !== "") {
    records.push(row);
  }
  return records;
}
