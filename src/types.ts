export type ItemStatus = "pending" | "processing" | "done" | "failed";

/** One saved item as stored on every device and synced through the PC server. */
export interface Item {
  id: string;
  status: ItemStatus;
  source: string;
  sourceRef: string;
  url: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  /** When the original post or article was published: "YYYY-MM-DD" or a UTC timestamp. Empty when unknown. */
  publishedAt?: string;
  error: string;
  siteName: string;
  /** Preview picture (og:image or the linked picture file itself). */
  image: string;
  /** A playable video file for the preview, when the page offers one. */
  video: string;
  /** More pictures from the article body. */
  images: string[];
  /** Exactly what the user saved. Never rewritten by organizing. */
  input: string;
  /** Text fetched from the linked page by the PC server. */
  page: string;
  /** 1 while there are local changes the server has not received yet (IndexedDB keys cannot be booleans). */
  dirty: 0 | 1;
}

export interface Tombstone {
  id: string;
  deletedAt: string;
  dirty: 0 | 1;
}

export interface ServerSettings {
  llm: { provider: string; endpoint: string; model: string; hasApiKey: boolean; fallback: boolean; ollamaModel: string };
  organize: { summaryLines: number; maxTags: number; render: boolean; useLogin: boolean };
  telegram: { enabled: boolean; hasBotToken: boolean; allowedChatIds: string[] };
  auth: { allowedLogins: string[] };
}

/** One provider in the automatic fallback chain: usable, missing, or only known to work when called. */
export interface ChainEntry {
  provider: string;
  label: string;
  state: "ready" | "missing" | "check";
  note: string;
}

export interface ServerStatus {
  llmStatus: { ready: boolean; message: string; chain?: ChainEntry[] };
  telegramStatus: { state: "off" | "ok" | "error"; username: string; error: string };
  storage: { vaultDir: string };
}
