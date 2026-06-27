/**
 * ThemeContext — app-wide light/dark theming.
 *
 * Mode is one of 'system' | 'light' | 'dark', persisted in AsyncStorage.
 * 'system' follows the OS appearance live. Migrated screens call useTheme()
 * to read the active semantic palette (makeTheme). Default is 'light' so the
 * dark rollout is strictly opt-in — existing screens are unaffected until the
 * user chooses Dark or System.
 */
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { makeTheme } from '../components/theme';

const MODE_KEY = '@dga_theme_mode';
const ThemeCtx = createContext({ theme: makeTheme('light'), mode: 'light', setMode: () => {} });

export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState('light');
  const [sysScheme, setSysScheme] = useState(Appearance.getColorScheme() || 'light');

  useEffect(() => {
    AsyncStorage.getItem(MODE_KEY).then((m) => {
      if (m === 'system' || m === 'light' || m === 'dark') setModeState(m);
    }).catch(() => {});
    const sub = Appearance.addChangeListener(({ colorScheme }) => setSysScheme(colorScheme || 'light'));
    return () => sub.remove();
  }, []);

  const setMode = useCallback((m) => {
    setModeState(m);
    AsyncStorage.setItem(MODE_KEY, m).catch(() => {});
  }, []);

  const effective = mode === 'system' ? (sysScheme === 'dark' ? 'dark' : 'light') : mode;
  const theme = useMemo(() => makeTheme(effective), [effective]);

  const value = useMemo(() => ({ theme, mode, setMode }), [theme, mode, setMode]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  return useContext(ThemeCtx);
}
