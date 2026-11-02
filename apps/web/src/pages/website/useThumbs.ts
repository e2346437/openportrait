import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.js";
import type { PickPhoto } from "../../lib/site.js";

export type Thumbs = Map<string, PickPhoto>;

/** Thumbnails for the photos a site uses. Only ids not seen before are asked for. */
export function useThumbs(ids: string[]): Thumbs {
  const [map, setMap] = useState<Thumbs>(new Map());
  const asked = useRef(new Set<string>());
  const key = [...ids].sort().join(",");
  useEffect(() => {
    const want = ids.filter((id) => !asked.current.has(id));
    if (!want.length) return;
    want.forEach((id) => asked.current.add(id));
    api<{ photos: PickPhoto[] }>("/site/photos", { body: { ids: want } })
      .then((r) => setMap((cur) => new Map([...cur, ...r.photos.map((p) => [p.id, p] as const)])))
      .catch(() => want.forEach((id) => asked.current.delete(id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return map;
}
