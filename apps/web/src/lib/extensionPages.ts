import { api } from "./api.js";
import { useSession } from "./session.js";
import { useLoad } from "./useLoad.js";

/** What an extension's page looks like (mirrors ExtensionPage on the server). The app draws it; extensions send no UI code. */
export interface PageColumn {
  key: string;
  label: string;
  format?: "text" | "money" | "date" | "number";
  unit?: string;
  sub?: string;
}
export interface PageField {
  name: string;
  label: string;
  type: "text" | "textarea" | "number" | "money" | "date" | "select" | "checkbox";
  hint?: string;
  required?: boolean;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  optionsRoute?: string;
  wide?: boolean;
}
export interface ExtensionPageDef {
  slug: string;
  title: string;
  icon?: string;
  group?: string;
  description?: string;
  filter?: { name: string; label: string; optionsRoute: string };
  summary?: { route: string; tiles: Array<{ key: string; label: string; format?: "text" | "money" | "number"; unit?: string }> };
  list: { route: string; columns: PageColumn[]; empty: { title: string; text: string } };
  form?: { title: string; addLabel: string; create: string; item: string; fields: PageField[] };
  export?: { label: string; route: string };
}

export interface ExtensionPageRef {
  extension: string;
  page: ExtensionPageDef;
}

/** The pages installed extensions add to the sidebar. Owner only, like the extensions themselves. */
export function useExtensionPages(): { pages: ExtensionPageRef[]; loading: boolean } {
  const { me } = useSession();
  const owner = me?.user?.role === "owner";
  const { data, loading } = useLoad<{ extensions: Array<{ id: string; status: string; pages?: ExtensionPageDef[] }> }>(owner ? "/extensions" : null);
  const pages = (data?.extensions ?? []).filter((e) => e.status === "loaded").flatMap((e) => (e.pages ?? []).map((page) => ({ extension: e.id, page })));
  return { pages, loading };
}

export const extensionApi = <T>(extension: string, route: string, init?: Parameters<typeof api>[1]) => api<T>(`/extensions/${extension}${route}`, init);
