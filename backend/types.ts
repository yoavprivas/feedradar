export type Method = "rss" | "jsonfeed" | "wordpress" | "html";
export type Entry = { title: string; url: string; publishedAt: string | null };
export type Discovered = {
  name: string;
  siteUrl: string;
  collectionUrl: string;
  method: Method;
  entries: Entry[];
};
export type Source = {
  id: string;
  name: string;
  site_url: string;
  collection_url: string;
  method: Method;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  article_count?: number;
};
export class AppError extends Error {
  constructor(
    public code: string,
    message = code,
    public status = 400,
  ) {
    super(message);
  }
}
export function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "NETWORK_ERROR";
}
