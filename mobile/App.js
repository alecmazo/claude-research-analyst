import React, { useEffect, useState, useCallback } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import * as Updates from 'expo-updates';

import HomeScreen             from './src/screens/HomeScreen';
import AnalysisScreen         from './src/screens/AnalysisScreen';
import ReportScreen           from './src/screens/ReportScreen';
import ScanScreen             from './src/screens/ScanScreen';
import PortfolioScreen        from './src/screens/PortfolioScreen';
import PortfolioSummaryScreen from './src/screens/PortfolioSummaryScreen';
import PaperTrackerScreen     from './src/screens/PaperTrackerScreen';
import IntelligenceScreen     from './src/screens/IntelligenceScreen';
import SettingsScreen         from './src/screens/SettingsScreen';
import FundScreen             from './src/screens/FundScreen';
import LoginScreen            from './src/screens/LoginScreen';
import LPPerformanceScreen    from './src/screens/LPPerformanceScreen';
import WatchlistScreen        from './src/screens/WatchlistScreen';
import CustomTabBar           from './src/components/CustomTabBar';

import { whoamiV2, getV2User } from './src/api/client';
import { colors } from './src/design';

const Stack = createNativeStackNavigator();
const Tab   = createBottomTabNavigator();

function HomeStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Home"     component={HomeScreen} />
      <Stack.Screen name="Analysis" component={AnalysisScreen} />
      <Stack.Screen name="Report"   component={ReportScreen} />
    </Stack.Navigator>
  );
}

function TrackerStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="TrackerHome" component={PaperTrackerScreen} />
    </Stack.Navigator>
  );
}

function IntelligenceStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="IntelligenceHome" component={IntelligenceScreen} />
      <Stack.Screen name="PaperTracker"     component={PaperTrackerScreen} />
    </Stack.Navigator>
  );
}

function FundStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="FundHome"        component={FundScreen} />
      <Stack.Screen name="PortfolioSummary" component={PortfolioSummaryScreen} />
    </Stack.Navigator>
  );
}

// ── GP navigator: full 7-tab access ─────────────────────────────────────────
function GPTabs() {
  return (
    <Tab.Navigator
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="Positions"    component={WatchlistScreen} />
      <Tab.Screen name="Research"     component={HomeStack} />
      <Tab.Screen name="Intelligence" component={IntelligenceStack} />
      <Tab.Screen name="Scan"         component={ScanScreen} />
      <Tab.Screen name="Portfolio"    component={TrackerStack} />
      <Tab.Screen name="Fund"         component={FundStack} />
      <Tab.Screen name="Settings"     component={SettingsScreen} />
    </Tab.Navigator>
  );
}

// ── LP navigator: scoped to live positions + performance + read-only research ──
function LPTabs({ onLogout }) {
  return (
    <Tab.Navigator
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="Positions" component={WatchlistScreen} />
      <Tab.Screen name="Performance">
        {() => <LPPerformanceScreen onLogout={onLogout} />}
      </Tab.Screen>
      <Tab.Screen name="Research" component={HomeStack} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

// ── Auto-OTA on cold launch ─────────────────────────────────────────────────
async function checkForOtaUpdate() {
  try {
    if (__DEV__) return;
    const result = await Updates.checkForUpdateAsync();
    if (result.isAvailable) {
      await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
    }
  } catch (e) {
    console.log('[OTA] update check skipped:', e?.message || e);
  }
}

export default function App() {
  // null = checking, 'login' = show login, otherwise the v2 user object
  const [authState, setAuthState] = useState(null);

  // Reconcile auth on launch + whenever someone logs in/out
  const refreshAuth = useCallback(async () => {
    // First, try the cached user for an instant render…
    const cached = await getV2User();
    if (cached) setAuthState(cached);

    // …then verify with the server to make sure the token is still good.
    const verified = await whoamiV2();
    setAuthState(verified || 'login');
  }, []);

  useEffect(() => {
    checkForOtaUpdate();
    refreshAuth();
  }, [refreshAuth]);

  const handleLoggedIn = useCallback((user) => setAuthState(user), []);
  const handleLogout   = useCallback(()      => setAuthState('login'), []);

  // ── Splash while we read AsyncStorage + verify ────────────────────────────
  if (authState === null) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.navy, alignItems: 'center', justifyContent: 'center' }}>
        <StatusBar style="light" />
        <ActivityIndicator color={colors.gold} size="large" />
      </View>
    );
  }

  // ── Not signed in → show login ───────────────────────────────────────────
  if (authState === 'login') {
    return (
      <>
        <StatusBar style="light" />
        <LoginScreen onLoggedIn={handleLoggedIn} />
      </>
    );
  }

  // ── Signed in → branch by role ───────────────────────────────────────────
  // Admin has full GP access (same tabs as GP)
  const isGPOrAdmin = authState.role === 'gp' || authState.role === 'admin';
  return (
    <NavigationContainer>
      <StatusBar style="light" />
      {isGPOrAdmin
        ? <GPTabs />
        : <LPTabs onLogout={handleLogout} />
      }
    </NavigationContainer>
  );
}
