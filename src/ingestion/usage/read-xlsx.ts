import ExcelJS from "exceljs";

export async function readXlsxTable(filePath: string): Promise<{ headers: string[]; rows: string[][] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return { headers: [], rows: [] };
  }

  const table: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    table.push(values.map((cell) => stringifyCell(cell)));
  });

  const headers = table[0] ?? [];
  const rows = table.slice(1);
  return { headers, rows };
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value && "text" in value && typeof value.text === "string") {
    return value.text;
  }
  if (typeof value === "object" && value && "result" in value) {
    return stringifyCell(value.result);
  }
  return String(value);
}
