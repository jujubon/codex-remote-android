import { useCallback, useRef, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { deviceRequest } from '../lib/deviceTools';
import type { ModelOption } from '../types/protocol';

const EMPTY_MODELS: ModelOption[] = [];

export function useAntigravityModels(config: RemoteConfig | null | undefined, connectionUrl: string | undefined, connected: boolean) {
  const [catalog, setCatalog] = useState<{ owner: RemoteConfig; options: ModelOption[]; loading: boolean; error?: string }>();
  const inFlight = useRef<RemoteConfig | null>(null);
  const cache = useRef<{ owner: RemoteConfig; options: ModelOption[]; expires: number } | undefined>(undefined);

  const refresh = useCallback(async (force = false) => {
    if (!config || !connected || inFlight.current === config) return;
    const saved = cache.current?.owner === config ? cache.current : undefined;
    if (!force && saved && Date.now() < saved.expires) return;
    inFlight.current = config;
    setCatalog({ owner: config, options: saved?.options ?? EMPTY_MODELS, loading: true });
    try {
      const { models } = await deviceRequest<{ models: ModelOption[] }>(
        { ...config, serverUrl: connectionUrl || config.serverUrl }, 'antigravity/models', force ? {} : undefined);
      if (!Array.isArray(models) || !models.length) throw new Error('电脑未返回可用模型。');
      if (inFlight.current !== config) return;
      cache.current = { owner: config, options: models, expires: Date.now() + 240_000 };
      setCatalog({ owner: config, options: models, loading: false });
    } catch (reason) {
      if (inFlight.current !== config) return;
      setCatalog({ owner: config, options: saved?.options ?? EMPTY_MODELS, loading: false,
        error: reason instanceof Error ? reason.message : '暂时无法读取模型。' });
    } finally {
      if (inFlight.current === config) inFlight.current = null;
    }
  }, [config, connectionUrl, connected]);

  const current = catalog?.owner === config ? catalog : undefined;
  return { options: current?.options ?? EMPTY_MODELS, loading: current?.loading ?? false, error: current?.error, refresh };
}

export type AntigravityModelCatalog = ReturnType<typeof useAntigravityModels>;
