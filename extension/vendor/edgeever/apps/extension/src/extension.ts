// Modified for Qingjian: authenticate with the existing admin login password.
import { t } from "./i18n";
import { adminPasswordAuthorization } from "../../../../../src/adminPassword";
export { adminPasswordAuthorization } from "../../../../../src/adminPassword";

export type ExtensionSettings = {
  instanceUrl: string;
  password: string;
  notebookId: string;
};

export type Notebook = { id: string; name: string; slug?: string | null };
export const DEFAULT_SETTINGS: ExtensionSettings = { instanceUrl: "", password: "", notebookId: "" };

const isInboxNotebook = (notebook: { id: string; slug?: string | null }) =>
  notebook.slug === "inbox" || notebook.id === "nb_inbox" || notebook.id.endsWith("_inbox");

export const clipNotebookId = (savedId: string, notebooks: { id: string; slug?: string | null }[]) => {
  const saved = savedId.trim();
  if (saved && notebooks.some((notebook) => notebook.id === saved)) return saved;
  return notebooks.find((notebook) => notebook.id.trim() && isInboxNotebook(notebook))?.id ?? "";
};

export const getSettings = async (): Promise<ExtensionSettings> => {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    instanceUrl: typeof stored.instanceUrl === "string" ? stored.instanceUrl : "",
    password: typeof stored.password === "string" ? stored.password : "",
    notebookId: typeof stored.notebookId === "string" ? stored.notebookId : "",
  };
};

export const saveSettings = async (settings: ExtensionSettings) => {
  await chrome.storage.local.set({ instanceUrl: settings.instanceUrl, password: settings.password, notebookId: settings.notebookId });
};

export const normalizeInstanceUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
};

export const getInstancePermissionPattern = (instanceUrl: string) => {
  const url = new URL(normalizeInstanceUrl(instanceUrl));
  return `${url.protocol}//${url.hostname}/*`;
};

export const requestInstancePermission = async (instanceUrl: string) => {
  const granted = await chrome.permissions.request({ origins: [getInstancePermissionPattern(instanceUrl)] });
  if (!granted) throw new Error(t("instancePermissionRequired"));
};

export const edgeEverRequest = async <T>(settings: ExtensionSettings, path: string, init?: RequestInit): Promise<T> => {
  const instanceUrl = normalizeInstanceUrl(settings.instanceUrl);
  if (!instanceUrl || !settings.password) throw new Error(t("missingSettingsDetails"));
  const response = await fetch(`${instanceUrl}${path}`, {
    ...init,
    credentials: "omit",
    headers: { ...init?.headers, "Content-Type": "application/json", Authorization: adminPasswordAuthorization(settings.password) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message || t("requestFailed", String(response.status)));
  }
  return response.json() as Promise<T>;
};

export const edgeEverFormRequest = async <T>(settings: ExtensionSettings, path: string, form: FormData, signal?: AbortSignal): Promise<T> => {
  const instanceUrl = normalizeInstanceUrl(settings.instanceUrl);
  if (!instanceUrl || !settings.password) throw new Error(t("missingSettingsDetails"));
  const response = await fetch(`${instanceUrl}${path}`, {
    method: "POST", credentials: "omit",
    headers: { Authorization: adminPasswordAuthorization(settings.password) },
    body: form, signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message || t("requestFailed", String(response.status)));
  }
  return response.json() as Promise<T>;
};

export const uploadMemoImage = async (settings: ExtensionSettings, memoId: string, file: { bytes: Uint8Array; mimeType: string; filename: string }, signal?: AbortSignal) => {
  const buffer = new ArrayBuffer(file.bytes.byteLength);
  new Uint8Array(buffer).set(file.bytes);
  const form = new FormData();
  form.append("file", new File([buffer], file.filename, { type: file.mimeType }));
  return edgeEverFormRequest<{ resource: { id: string } }>(settings, `/api/v1/memos/${encodeURIComponent(memoId)}/resources`, form, signal);
};

export const listNotebooks = (settings: ExtensionSettings) => edgeEverRequest<{ notebooks: Notebook[] }>(settings, "/api/v1/notebooks");
export const testConnection = async (settings: ExtensionSettings) => {
  await requestInstancePermission(settings.instanceUrl);
  return (await listNotebooks(settings)).notebooks;
};
