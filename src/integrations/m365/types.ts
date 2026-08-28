import type { RetrievalState } from "../../domain/retrieval-state.js";

export type GraphHttpResult = {
  ok: boolean;
  status: number;
  noContent: boolean;
  json: unknown;
  retrieval: RetrievalState;
};

export type GraphUserProfile = {
  id?: string;
  mail?: string;
  userPrincipalName?: string;
  displayName?: string;
};

export type GraphMessageList = {
  value?: unknown[];
  "@odata.nextLink"?: string;
};
