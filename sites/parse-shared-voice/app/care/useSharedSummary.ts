/* eslint react-hooks/set-state-in-effect: "off" -- Clear the retained summary immediately when its access context changes. */
"use client";

import { useEffect, useState } from 'react';
import { api, ApiError, Row } from './api';

type State = { data: Row | null; loading: boolean; error: string };
const checking: State = { data: null, loading: true, error: '' };

/** A retained browser tab must not treat its first successful read as permanent access. */
export function useSharedSummary(token: string): State {
  const [state, setState] = useState<State>(checking);
  useEffect(() => {
    if (!token) return;
    let active = true;
    let terminal = false;
    let current: AbortController | null = null;
    let deadline: number | undefined;
    const stop = () => {
      current?.abort();
      current = null;
      window.clearTimeout(deadline);
    };
    const refresh = async () => {
      if (!active || terminal || current || document.visibilityState !== 'visible') return;
      const request = new AbortController();
      current = request;
      deadline = window.setTimeout(() => {
        if (!active || current !== request) return;
        stop();
        setState({ data: null, loading: false, error: 'Could not check this shared summary. Check your connection; Parse will try again while this page is open.' });
      }, 10000);
      try {
        const data = await api.sharedSummary(decodeURIComponent(token), request.signal);
        if (active && current === request) setState({ data, loading: false, error: '' });
      } catch (error) {
        if (active && current === request) {
          terminal = error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
          setState({ data: null, loading: false, error: error instanceof Error ? error.message : 'Could not check this shared summary.' });
        }
      } finally {
        if (current === request) {
          window.clearTimeout(deadline);
          current = null;
        }
      }
    };
    const hide = () => { stop(); setState(checking); };
    const resume = () => {
      hide();
      terminal = false;
      void refresh();
    };
    const visibility = () => document.visibilityState === 'visible' ? resume() : hide();
    setState(checking);
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', resume);
    return () => {
      active = false;
      stop();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('focus', resume);
    };
  }, [token]);
  return state;
}
