import { ZOHO_CRM_API_VERSION } from "./constants.js";
import { ZohoHttp, asJsonObject } from "./http.js";
import type { ZohoHttpResult } from "./types.js";

export type CreateNoteInput = {
  parentModule: string;
  parentRecordId: string;
  title: string;
  content: string;
};

export type CreateNoteResult = {
  ok: boolean;
  noteId?: string;
  error?: string;
  status?: number;
};

export function noteIdFromCreateResponse(json: unknown): string | undefined {
  const root = asJsonObject(json);
  const data = Array.isArray(root?.data) ? root.data : [];
  const first = asJsonObject(data[0]);
  const details = asJsonObject(first?.details);
  if (typeof details?.id === "string") return details.id;
  if (typeof first?.id === "string") return first.id;
  return undefined;
}

export function createNoteErrorMessage(json: unknown, status: number): string {
  const root = asJsonObject(json);
  const data = Array.isArray(root?.data) ? root.data : [];
  const first = asJsonObject(data[0]);
  if (typeof first?.message === "string") return first.message;
  if (typeof root?.message === "string") return root.message;
  return `Zoho Notes write failed (${status}).`;
}

export class ZohoCrmWriteClient {
  constructor(private readonly http: ZohoHttp) {}

  createNote(input: CreateNoteInput): Promise<ZohoHttpResult> {
    return this.http.post(`/crm/${ZOHO_CRM_API_VERSION}/Notes`, {
      data: [
        {
          Note_Title: input.title,
          Note_Content: input.content,
          Parent_Id: {
            module: { api_name: input.parentModule },
            id: input.parentRecordId,
          },
        },
      ],
    });
  }

  async createNoteResult(input: CreateNoteInput): Promise<CreateNoteResult> {
    const result = await this.createNote(input);
    if (result.ok) {
      const noteId = noteIdFromCreateResponse(result.json);
      if (!noteId) {
        return { ok: false, status: result.status, error: "Zoho accepted the note but did not return a note id." };
      }
      return { ok: true, noteId, status: result.status };
    }
    return {
      ok: false,
      status: result.status,
      error: createNoteErrorMessage(result.json, result.status),
    };
  }
}

export type ZohoNoteWriter = {
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
};

export function writerFromClient(client: ZohoCrmWriteClient): ZohoNoteWriter {
  return {
    createNote: (input) => client.createNoteResult(input),
  };
}
