'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  APPEARANCE_EVENT,
  DEFAULT_APPEARANCE,
  applyAppearance,
  loadAppearance,
  setAppearance,
  type Appearance,
} from './appearance';

/** 订阅式读取外观设置（跨组件同步） */
export function useAppearance(): [Appearance, (next: Appearance) => void, boolean] {
  const [value, setValue] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => setValue(loadAppearance());
    sync();
    applyAppearance(loadAppearance());
    setReady(true);
    window.addEventListener(APPEARANCE_EVENT, sync);
    return () => window.removeEventListener(APPEARANCE_EVENT, sync);
  }, []);

  const update = useCallback((next: Appearance) => setAppearance(next), []);
  return [value, update, ready];
}
